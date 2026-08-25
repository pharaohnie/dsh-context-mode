// knowledge/execute.ts — ctx_execute / ctx_execute_file / ctx_batch_execute（复用 DSH codeRuntime）
// P0 主引擎：Think-in-Code。模型写程序（异步函数体，顶层 await/return），只把 logs+value 带回上下文。
// 复用宿主 codeRuntime（worker-thread 隔离/空环境/heap cap/硬中断）；**不自建沙箱**。
// 安全图景（B1）：codeRuntime 是「资源隔离（非数据沙箱）」，信任姿态与 bash 同级；默认不注入 fs/writeText binding，
//   只经 ctx.fs.readText 读文件作数据；**不承诺**程序无法读/写宿主文件（设计取向，减小攻击面，非安全边界）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { addChunk, deleteByRef, incMeta, searchChunks } from './sqlite.ts'
import { concurrencyPool } from './web.ts'
import { SEARCH_BUDGET_BYTES } from './tools.ts'
import { byteLen } from '../util/bytes.ts'

export interface ExecuteDeps {
  config: {
    executeEnabled: boolean
    executeDefaultLanguage: string
    executeAllowShell: boolean
    executeTimeoutMs: number
    executeConcurrency: number
    knowledgeBaseTtlMs: number
    maxSourceBytes?: number
  }
  kdb: { db: any } | null
}

const textSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    count: { type: 'number', required: true },
  },
} as const

function serializeValue(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 简单字符串 hash（batch ref 用）。 */
function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export interface RunSandboxOpts { signal?: AbortSignal; timeoutMs?: number }

/** 已知的「沙箱无模块系统」错误特征（A2，2026-08-25 修正计划）：codeRuntime 程序体是严格模式 AsyncFunction
 *  （bindings + console shim），无 require/import；模型误用模块系统时按此追加改写指引。 */
const SANDBOX_MODULE_ERROR = /require is not defined|module is not defined|cannot use import statement|import is not defined/i

/** 命中已知「沙箱无模块系统」错误时返回改写指引，否则返回空串（纯函数，供 smoke 直测）。 */
export function sandboxErrorHint(message: string): string {
  if (!message || !SANDBOX_MODULE_ERROR.test(message)) return ''
  return '提示：沙箱无模块系统（require/import 均不可用）。直接使用已注入的变量（如 FILE_SRC，已是文件完整内容字符串）与标准 JS 内置；需要文件系统或命令行请改用 language:"shell" 或原生 bash 工具。'
}

/** 在沙箱里运行一段程序，只回 {text,count}。
 *  基础设施/前提失败（shell 不可用/语言不支持/codeRuntime 未挂载）→ throw（框架视为 isError，P1①）。
 *  程序自身失败（CodeRunResult.error；run() 不 reject，error 是结果字段）→ 返回错误文本（这是结果而非基础设施异常）。 */
export async function runSandbox(ctx: { get(name: string): unknown }, code: string, language?: string, opts: RunSandboxOpts = {}): Promise<{ text: string; count: number }> {
  const lang = (language || 'ts').toLowerCase()
  if (lang === 'shell' || lang === 'bash') {
    const shell = ctx.get('shell') as { run?: (spec: any) => Promise<any> } | undefined
    if (!shell || typeof shell.run !== 'function') throw new Error('context-mode: shell 服务不可用（DSH 宿主未挂载 shell；executeAllowShell 仅控制本插件是否放行 shell 路由）')
    const res = await shell.run({ command: code, signal: opts.signal, timeoutMs: opts.timeoutMs || undefined })
    const out = [res?.stdout, res?.stderr].filter((x) => typeof x === 'string').join('\n')
    return { text: out, count: 1 }
  }
  if (lang !== 'ts' && lang !== 'typescript' && lang !== 'js') throw new Error(`context-mode: 不支持语言 ${lang}（当前支持 ts/typescript/js 与 shell/bash）`)
  const rt = ctx.get('codeRuntime') as { run?: (req: any) => Promise<any> } | undefined
  if (!rt || typeof rt.run !== 'function') throw new Error('context-mode: codeRuntime 未挂载（宿主未提供）')
  const res = await rt.run({ program: code, bindings: [], signal: opts.signal })
  if (res?.error) {
    // A2：命中已知模块系统误用时追加改写指引，模型一步自愈
    const hint = sandboxErrorHint(String(res.error.message ?? ''))
    return { text: `context-mode: codeRuntime 失败 [${res.error.kind}] ${res.error.message}${hint ? '\n' + hint : ''}`, count: 0 }
  }
  const logs = Array.isArray(res?.logs) ? res.logs.join('\n') : ''
  const value = res?.value === undefined ? '' : serializeValue(res.value)
  return { text: [logs, value].filter(Boolean).join('\n'), count: 1 }
}

export function registerExecuteTools(ctx: { tools: { register(def: unknown): unknown }; get(name: string): unknown }, deps: ExecuteDeps) {
  const { kdb, config } = deps
  const requireDb = () => {
    if (!kdb) throw new Error('context-mode 知识库未就绪（目录不可写？）')
    return kdb.db
  }
  const countRun = (d: any, text: string) => {
    incMeta(d, 'execute_runs', 1)
    incMeta(d, 'execute_log_bytes', byteLen(text))
  }

  ctx.tools.register(defineTool({
    name: 'ctx_execute',
    description: '在沙箱里运行模型写的一段程序（Think-in-Code），只把 stdout+返回值得回上下文，原始数据留在沙箱。何时用：分析/统计/过滤/比较/搜索/解析/转换数据、跑程序/调 API、处理大输出时——代替 bash 直跑拿大输出。当你要处理/分析/汇总大输出、或跑命令要拿结果时用，结果只回答案，原始数据留沙箱。',
    parameters: {
      language: { type: 'string', enum: ['ts', 'typescript', 'js', 'shell', 'bash'], description: '默认 ts；shell 路由默认开启（executeAllowShell=true）' },
      code: { type: 'string', required: true, description: '程序体（async function body，支持顶层 await/return，返回值即 value）。无 require/import（沙箱无模块系统），可用标准 JS 内置 + console.log；要文件系统/命令行请改用 language:"shell" 或 bash 工具' },
      timeoutMs: { type: 'number', description: '可选信号；不传归由宿主 computeMs/maxWallMs 预算' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { language?: 'ts' | 'typescript' | 'js' | 'shell' | 'bash'; code: string; timeoutMs?: number }, exec: any) {
      if (!config.executeEnabled) throw new Error('context-mode: ctx_execute 未启用（executeEnabled=false）')
      const d = requireDb()
      const res = await runSandbox(ctx, args.code, args.language ?? config.executeDefaultLanguage, { signal: exec?.signal, timeoutMs: args.timeoutMs })
      countRun(d, res.text)
      return { text: res.text, count: res.count }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_execute_file',
    description: '读一个文件的内容作为数据（FILE_SRC），对其运行一段分析代码，只把结果带回。何时用：读文件做分析/摘要/抽取/统计时，文件内容作为 FILE_SRC 留在沙箱，只回答案——读文件做统计/抽取时，代替 read 整读。',
    parameters: {
      path: { type: 'string', required: true, description: '要作为数据分析的文件路径' },
      language: { type: 'string', enum: ['ts', 'typescript', 'js', 'shell', 'bash'], description: '分析代码语言，默认 ts' },
      code: { type: 'string', description: '分析程序（async function body，顶层 await/return 可用）。FILE_SRC 已是该文件完整内容（string），直接处理它、不要再读文件/当路径用；无 require/import（沙箱无模块系统）' },
      timeoutMs: { type: 'number' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { path: string; language?: 'ts' | 'typescript' | 'js' | 'shell' | 'bash'; code?: string; timeoutMs?: number }, exec: any) {
      if (!config.executeEnabled) throw new Error('context-mode: ctx_execute_file 未启用（executeEnabled=false）')
      const d = requireDb()
      const fs = ctx.get('fs') as { resolve?: (p: string, o?: any) => Promise<any>; readText?: (t: any, s?: any) => Promise<string> } | undefined
      let src: string
      try {
        const cwd = exec?.agent?.session?.header?.cwd
        const target = await (fs?.resolve ? fs.resolve(args.path, cwd ? { cwd } : undefined) : undefined)
        if (target == null) throw new Error('路径无法解析')
        if (!fs?.readText) throw new Error('fs.readText 不可用')
        src = await fs.readText(target, exec?.signal)
        // R3-3（D-H2/B-06）：对称上限（与 read 门禁/ctx_index 一致），超限引导分片索引
        if (byteLen(src) > (config.maxSourceBytes ?? 2_000_000)) {
          throw new Error(`context-mode: 文件 ${args.path} 超过 ${config.maxSourceBytes ?? 2_000_000} 字节上限（B-06），请用 ctx_index 分片索引 + ctx_search。`)
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('context-mode:')) throw e
        throw new Error(`context-mode: 读取文件失败 ${(e as Error).message}`) // P1①：前提/基础设施失败 throw（isError），而非成功值
      }
      const code = args.code ?? 'return typeof FILE_SRC === "string" ? FILE_SRC.length : 0'
      const program = `const FILE_SRC = (${JSON.stringify(src)});\n${code}`
      const res = await runSandbox(ctx, program, args.language ?? 'ts', { signal: exec?.signal, timeoutMs: args.timeoutMs })
      countRun(d, res.text)
      return { text: res.text, count: res.count }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_batch_execute',
    description: '并行跑多段程序、各自结果自动入库（batch:<sid>:<hash>），同轮可用 queries 检索命中片段。何时用：一次要并行多段计算/命令并同轮检索时，一调多用替代多次分开调用；并发 1-8。',
    parameters: {
      commands: { type: 'array', required: true, items: { type: 'string' }, description: '一段段程序（async function body；无 require/import，需文件系统/命令行改用 language:"shell"）' },
      queries: { type: 'array', items: { type: 'string' }, description: '同轮检索词（对已入库结果取片段）' },
      language: { type: 'string', enum: ['ts', 'typescript', 'js', 'shell', 'bash'], description: '默认 ts' },
      concurrency: { type: 'number', description: '1-8，默认按 config' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { commands: string[]; queries?: string[]; language?: 'ts' | 'typescript' | 'js' | 'shell' | 'bash'; concurrency?: number }, exec: any) {
      if (!config.executeEnabled) throw new Error('context-mode: ctx_batch_execute 未启用（executeEnabled=false）')
      const d = requireDb()
      const sid = exec?.agent?.sessionId ?? 'anon'
      const concurrency = Math.min(8, Math.max(1, args.concurrency ?? config.executeConcurrency))
      const ttl = config.knowledgeBaseTtlMs
      const results: string[] = []
      const items = args.commands.map((cmd, i) => ({ cmd, i }))
      await concurrencyPool(items, concurrency, async (item) => {
        const res = await runSandbox(ctx, item.cmd, args.language ?? 'ts', { signal: exec?.signal })
        const ref = `batch:${sid}:${item.i}:${hash(item.cmd)}` // R4-6（B-01）：加下标唯一化，防同命令 ref 冲突
        try { deleteByRef(d, ref); addChunk(d, ref, `batch ${item.i + 1}`, res.text, ttl) } catch (e) { console.warn('[context-mode] batch 索引失败:', (e as Error).message) } // R5-2（B-08f）：失败留痕
        results[item.i] = `[${item.i + 1}] ${res.text.slice(0, 500)}`
      })
      incMeta(d, 'execute_runs', args.commands.length)
      let text = results.join('\n')
      if (Array.isArray(args.queries) && args.queries.length) {
        const merged: { id: number; snippet: string; score: number }[] = []
        const seen = new Set<number>()
        for (const q of args.queries) {
          for (const h of searchChunks(d, { query: q, topN: 3, budgetBytes: 300 })) {
            if (!seen.has(h.id)) { seen.add(h.id); merged.push(h) }
          }
        }
        merged.sort((a, b) => b.score - a.score)
        const snippet = merged.slice(0, 5).map((h) => `- ${h.snippet}`).join('\n')
        text += `\n\n同轮检索命中：\n${snippet}`
      }
      return { text: text.slice(0, SEARCH_BUDGET_BYTES), count: results.length }
    },
  }))
}
