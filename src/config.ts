// config.ts — context-mode 配置 schema（Schemastery，与真实插件同范式）
// 注意：erasable TS 语法（无 enum/namespace）；相对导入必须带 .ts 后缀
import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import path from 'node:path'

const defaultKnowledgeDir = path.join(os.homedir(), '.context-mode', 'content')

export const Config = z.object({
  // B 路由强制总开关
  routingEnabled: z.boolean().default(true),
  // 硬 deny curl/wget/inline-fetch（不参与 fail-open 降级）
  denyCurlWget: z.boolean().default(true),
  // 无界 bash 首命令词+字节阈值；0 = 不触发（早期默认关闭）。P1 软引导：>0 且超阈值时，对长 bash 给「改用 ctx_*」的软提示（有审批 ask、无审批放行）。
  bashNudgeMinCommandBytes: z.number().default(1000),
  // R2-4（D-H1）：语义对齐键——旧名 maxReadBytesBeforeAsk（实为 deny 阈值）保留为 deprecated 兼容键，新键优先。
  maxReadDenyBytes: z.number(),
  // 整读引导（deny）阈值：stat.size > 该值才触发 deny+引导。对齐 read 工具自身 readMaxBytes（≈50KB=51200）。
  maxReadBytesBeforeAsk: z.number().default(51200),
  // 【新增】read「自动引导到检索」规则独立开关；关 = 回到现状（read 从不门禁）。首版只保留这一个总开关，不引入 readRoutingMode。
  autoGuideRead: z.boolean().default(true),
  // 【新增】带 offset/limit 的精确读是否豁免门禁（显式分段读是合法意图，放行）。
  readAllowBounded: z.boolean().default(true),
  // 【新增】信任文档 basename 白名单（basename 命中 + size≤headroom 双条件豁免）。
  trustedReadBasenames: z.array(z.string()).default(['README', 'CHANGELOG', 'LICENSE', 'AGENTS', 'package.json']),
  // 【新增】信任文档可放宽到 maxReadBytesBeforeAsk × N。R5-7（S-L4）：默认 4→2 收紧豁免放大。
  trustedDocHeadroom: z.number().default(2),
  // P0 沙箱执行（复用 DSH codeRuntime；executeAllowShell 默认开；并发 1-8）
  executeEnabled: z.boolean().default(true),
  executeDefaultLanguage: z.string().default('ts'),
  executeAllowShell: z.boolean().default(true),
  executeTimeoutMs: z.number().default(0),
  executeConcurrency: z.number().default(4),
  // R3-3（D-H2/B-06）：ctx_execute_file / ctx_index 单文件内容上限（防整读大文件进内存/worker 重编译）
  maxSourceBytes: z.number().default(2_000_000),
  // A 知识库
  knowledgeBaseDir: z.string().default(defaultKnowledgeDir),
  knowledgeBaseTtlMs: z.number().default(86_400_000),
  knowledgeBaseConcurrency: z.number().default(4),
  // P1b 会话记忆（默认 opt-in 关，B3；TTL 非 0 控制生命周期）
  memoryCapture: z.boolean().default(false),
  memoryTtlMs: z.number().default(7 * 86_400_000),
  memoryResumeTopN: z.number().default(3),
  memoryResumeBytes: z.number().default(800),
  // P2a advice 结构化
  adviceStructured: z.boolean().default(true),
  adviceRich: z.boolean().default(true),
  // P2c 可选记账明细表
  accountingLedger: z.boolean().default(false),
  // 【新增】结构性有界白名单（P1-2）：无害单命令（白名单 + 无控制运算符）→ 零摩擦放行，不碰长命令 ask。
  // R1-3（S-H3）：移除 cat/git——cat 是整读等价物（会绕过 read 门禁），git 大输出子命令（log/diff）可成输出洪水。
  boundedWhitelist: z.array(z.string()).default(['pwd', 'echo', 'ls', 'wc', 'whoami', 'date']),
  // 【新增】默认安全基线（P0-2，默认关，避免强开打扰）。R5-8（D-M2）诚实标注：当前仅作用于 read 工具的 file_path，
  // 不覆盖 bash / ctx_index / ctx_execute_file 的目标路径；开启后按 allow/deny glob 对 read 做判定。
  securityEnabled: z.boolean().default(false),
  securityAllowGlobs: z.array(z.string()).default([]),
  securityDenyGlobs: z.array(z.string()).default([]),
  // P2 搜索 FloodGuard 时间窗节流（对齐官方 SEARCH_WINDOW_MS / SEARCH_MAX_RESULTS_AFTER / SEARCH_BLOCK_AFTER；0=关）
  searchWindowMs: z.number().default(60_000),
  searchMaxResultsAfter: z.number().default(3),
  searchBlockAfter: z.number().default(8),
  // C 会话连续性
  sessionContinuity: z.boolean().default(true),
  continuityTopN: z.number().default(20),
  // 【新增】子代理上下文守卫（对齐官方 Agent 分支：给子代理注入 context_window_protection 保护块，防其绕过门禁整读）。默认关。
  subagentGuidance: z.boolean().default(false),
})

export interface ContextModeConfig {
  routingEnabled: boolean
  denyCurlWget: boolean
  bashNudgeMinCommandBytes: number
  maxReadBytesBeforeAsk: number
  maxReadDenyBytes?: number
  autoGuideRead: boolean
  readAllowBounded: boolean
  trustedReadBasenames: string[]
  trustedDocHeadroom: number
  executeEnabled: boolean
  executeDefaultLanguage: string
  executeAllowShell: boolean
  executeTimeoutMs: number
  executeConcurrency: number
  maxSourceBytes?: number
  knowledgeBaseDir: string
  knowledgeBaseTtlMs: number
  knowledgeBaseConcurrency: number
  memoryCapture: boolean
  memoryTtlMs: number
  memoryResumeTopN: number
  memoryResumeBytes: number
  adviceStructured: boolean
  adviceRich: boolean
  accountingLedger: boolean
  sessionContinuity: boolean
  continuityTopN: number
  boundedWhitelist: string[]
  securityEnabled: boolean
  securityAllowGlobs: string[]
  securityDenyGlobs: string[]
  searchWindowMs: number
  searchMaxResultsAfter: number
  searchBlockAfter: number
  subagentGuidance: boolean
}

/** 显式默认值：即便 loader 未对 config 应用 schema 默认，也用此兜底。
 *  从 schema 推导（P3-1 单一来源）：schema 默认改了，DEFAULT_CONFIG 自动跟随，避免手写两份漂移。
 *  注：本插件实测 bundle 机制 loader 不应用 schemastery 默认值，故仍需要此兜底（环境事实，README 已记录）。 */
export const DEFAULT_CONFIG: ContextModeConfig = (Config['~standard'].validate({}) as { value: ContextModeConfig }).value

/** P3-1 环境变量运行时覆盖（对齐官方 env 调参）。优先级：显式 rawConfig > env > DEFAULT_CONFIG。
 *  读取 CONTEXT_MODE_* 变量，解析为数字/布尔/字符串/数组，仅覆盖存在的键；缺失或空串不覆盖。
 *  `env` 参数默认可注入：便于测试与在非 Node 环境探测（DSH 主进程必有 process.env）。 */
export function envConfigOverrides(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {})): Partial<ContextModeConfig> {
  const out: Partial<ContextModeConfig> = {}
  const num = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = env[k]
      if (v !== undefined && v !== '') {
        const n = Number(v)
        if (Number.isFinite(n)) return n
      }
    }
    return undefined
  }
  const bool = (keys: string[]): boolean | undefined => {
    for (const k of keys) {
      const v = env[k]
      if (v === undefined || v === '') continue
      const low = v.toLowerCase()
      if (['1', 'true', 'on', 'yes'].includes(low)) return true
      if (['0', 'false', 'off', 'no'].includes(low)) return false
    }
    return undefined
  }
  const list = (keys: string[]): string[] | undefined => {
    for (const k of keys) {
      const v = env[k]
      if (v !== undefined && v !== '') return v.split(',').map((s) => s.trim()).filter(Boolean)
    }
    return undefined
  }
  // 读阈值/体积（入口覆盖 bash nudge 与 read 门禁）
  const bashNudge = num(['CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES', 'BASH_NUDGE_MIN_COMMAND_BYTES'])
  if (bashNudge !== undefined) out.bashNudgeMinCommandBytes = bashNudge
  const maxRead = num(['CONTEXT_MODE_MAX_READ_BYTES', 'CONTEXT_MODE_READ_MAX_BYTES'])
  if (maxRead !== undefined) out.maxReadBytesBeforeAsk = maxRead
  // 搜索 FloodGuard 时间窗节流
  const sw = num(['CONTEXT_MODE_SEARCH_WINDOW_MS'])
  if (sw !== undefined) out.searchWindowMs = sw
  const sra = num(['CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER'])
  if (sra !== undefined) out.searchMaxResultsAfter = sra
  const sba = num(['CONTEXT_MODE_SEARCH_BLOCK_AFTER'])
  if (sba !== undefined) out.searchBlockAfter = sba
  // 安全
  const sec = bool(['CONTEXT_MODE_REQUIRE_SECURITY'])
  if (sec !== undefined) out.securityEnabled = sec
  const allow = list(['CONTEXT_MODE_ALLOW_GLOBS'])
  if (allow !== undefined) out.securityAllowGlobs = allow
  const deny = list(['CONTEXT_MODE_DENY_GLOBS'])
  if (deny !== undefined) out.securityDenyGlobs = deny
  // 根目录 / 记忆 / 连续性
  const dir = env['CONTEXT_MODE_DIR']
  if (dir) out.knowledgeBaseDir = dir
  const mem = bool(['CONTEXT_MODE_MEMORY_CAPTURE'])
  if (mem !== undefined) out.memoryCapture = mem
  const sub = bool(['CONTEXT_MODE_SUBAGENT_GUIDANCE'])
  if (sub !== undefined) out.subagentGuidance = sub
  // 调试开关（显式布尔；语义为「是否开启调试」，无反向）
  const debug = bool(['CONTEXT_MODE_DEBUG'])
  if (debug !== undefined) out.accountingLedger = debug
  return out
}
