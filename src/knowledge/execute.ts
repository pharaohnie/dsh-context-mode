// knowledge/execute.ts — ctx_execute / ctx_execute_file / ctx_batch_execute（复用 DSH codeRuntime）
// P0 主引擎：Think-in-Code。模型写程序（异步函数体，顶层 await/return），只把 logs+value 带回上下文。
// 复用宿主 codeRuntime（worker-thread 隔离/空环境/heap cap/硬中断）；**不自建沙箱**。
// 安全图景（B1）：codeRuntime 是「资源隔离（非数据沙箱）」，信任姿态与 bash 同级；默认不注入 fs/writeText binding，
//   只经 ctx.fs.readText 读文件作数据；**不承诺**程序无法读/写宿主文件（设计取向，减小攻击面，非安全边界）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { addChunk, deleteByRef, incMeta, searchChunks } from './sqlite.ts'
import { concurrencyPool } from './web.ts'
import { SEARCH_BUDGET_BYTES } from './tools.ts'

export interface ExecuteDeps {
  config: {
    executeEnabled: boolean
    executeDefaultLanguage: string
    executeAllowShell: boolean
    executeTimeoutMs: number
    executeConcurrency: number
    knowledgeBaseTtlMs: number
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
}

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

/** 在沙箱里运行一段程序，只回 {text,count}。
 *  基础设施/前提失败（shell 不可用/语言不支持/codeRuntime 未挂载）→ throw（框架视为 isError，P1①）。
 *  程序自身失败（CodeRunResult.error；run() 不 reject，error 是结果字段）→ 返回错误文本（这是结果而非基础设施异常）。 */
export async function runSandbox(ctx: { get(name: string): unknown }, code: string, language?: string, opts: RunSandboxOpts = {}): Promise<{ text: string; count: number }> {
  const lang = (language || 'ts').toLowerCase()
  if (lang === 'shell' || lang === 'bash') {
    const shell = ctx.get('shell') as { run?: (spec: any) => Promise<any> } | undefined
    if (!shell || typeof shell.run !== 'function') throw new Error('context-mode: shell 不可用（executeAllowShell 需开启且宿主挂载 shell）')
    const res = await shell.run({ command: code, signal: opts.signal, timeoutMs: opts.timeoutMs || undefined })
    const out = [res?.stdout, res?.stderr].filter((x) => typeof x === 'string').join('\n')
    return { text: out, count: 1 }
  }
  if (lang !== 'ts' && lang !== 'typescript' && lang !== 'js') throw new Error(`context-mode: 不支持语言 ${lang}（当前仅 ts/typescript/js；shell 需开启 executeAllowShell）`)
  const rt = ctx.get('codeRuntime') as { run?: (req: any) => Promise<any> } | undefined
  if (!rt || typeof rt.run !== 'function') throw new Error('context-mode: codeRuntime 未挂载（宿主未提供）')
  const res = await rt.run({ program: code, bindings: [], signal: opts.signal })
  if (res?.error) return { text: `context-mode: codeRuntime 失败 [${res.error.kind}] ${res.error.message}`, count: 0 }
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
    incMeta(d, 'execute_log_bytes', text.length)
  }

  ctx.tools.register(defineTool({
    name: 'ctx_execute',
    description: '在沙箱里运行模型写的一段程序（Think-in-Code），只把 stdout+返回值得回上下文，原始数据留在沙箱。何时用：分析/统计/过滤/比较/搜索/解析/转换数据、跑程序/调 API、处理大输出时——代替 bash 直跑拿大输出。当你要处理/分析/汇总大输出、或跑命令要拿结果时用，结果只回答案，原始数据留沙箱。',
    parameters: {
      language: { type: 'string', enum: ['ts', 'typescript', 'js', 'shell', 'bash'], description: '默认 ts；shell 需开启 executeAllowShell' },
      code: { type: 'string', required: true, description: '程序体（async function body，支持顶层 await/return，返回值即 value）' },
      timeoutMs: { type: 'number', description: '可选信号；不传归由宿主 computeMs/maxWallMs 预算' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { language?: string; code: string; timeoutMs?: number }, exec: any) {
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
      code: { type: 'string', description: '分析程序（在 codeRuntime 跑，可用 FILE_SRC 变量引用文件内容）' },
      timeoutMs: { type: 'number' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { path: string; language?: string; code?: string; timeoutMs?: number }, exec: any) {
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
      commands: { type: 'array', required: true, items: { type: 'string' }, description: '一段段程序' },
      queries: { type: 'array', items: { type: 'string' }, description: '同轮检索词（对已入库结果取片段）' },
      language: { type: 'string', enum: ['ts', 'typescript', 'js', 'shell', 'bash'], description: '默认 ts' },
      concurrency: { type: 'number', description: '1-8，默认按 config' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { commands: string[]; queries?: string[]; language?: string; concurrency?: number }, exec: any) {
      if (!config.executeEnabled) throw new Error('context-mode: ctx_batch_execute 未启用（executeEnabled=false）')
      const d = requireDb()
      const sid = exec?.agent?.sessionId ?? 'anon'
      const concurrency = Math.min(8, Math.max(1, args.concurrency ?? config.executeConcurrency))
      const ttl = config.knowledgeBaseTtlMs
      const results: string[] = []
      const items = args.commands.map((cmd, i) => ({ cmd, i }))
      await concurrencyPool(items, concurrency, async (item) => {
        const res = await runSandbox(ctx, item.cmd, args.language ?? 'ts', { signal: exec?.signal })
        const ref = `batch:${sid}:${hash(item.cmd)}`
        try { deleteByRef(d, ref); addChunk(d, ref, `batch ${item.i + 1}`, res.text, ttl) } catch { /* 索引失败不阻塞 */ }
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
