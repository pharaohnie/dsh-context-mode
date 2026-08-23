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
  // 无界 bash 首命令词+字节阈值；0 = 不触发
  bashNudgeMinCommandBytes: z.number().default(0),
  // 整读引导（deny）阈值：stat.size > 该值才触发 deny+引导。对齐 read 工具自身 readMaxBytes（≈50KB=51200）。
  // 注：字段名带 ask 但实为 deny 阈值——语义别名见下方 readFloodDenyBytes 注释；maxReadBytesBeforeAsk 保留为兼容键。
  maxReadBytesBeforeAsk: z.number().default(51200),
  // 【新增】read「自动引导到检索」规则独立开关；关 = 回到现状（read 从不门禁）。首版只保留这一个总开关，不引入 readRoutingMode。
  autoGuideRead: z.boolean().default(true),
  // 【新增】带 offset/limit 的精确读是否豁免门禁（显式分段读是合法意图，放行）。
  readAllowBounded: z.boolean().default(true),
  // 【新增】信任文档 basename 白名单（basename 命中 + size≤headroom 双条件豁免）。
  trustedReadBasenames: z.array(z.string()).default(['README', 'CHANGELOG', 'LICENSE', 'AGENTS', 'package.json']),
  // 【新增】信任文档可放宽到 maxReadBytesBeforeAsk × N。
  trustedDocHeadroom: z.number().default(4),
  // P0 沙箱执行（复用 DSH codeRuntime；executeAllowShell 默认关；并发 1-8）
  executeEnabled: z.boolean().default(true),
  executeDefaultLanguage: z.string().default('ts'),
  executeAllowShell: z.boolean().default(false),
  executeTimeoutMs: z.number().default(0),
  executeConcurrency: z.number().default(4),
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
  // C 会话连续性
  sessionContinuity: z.boolean().default(true),
  continuityTopN: z.number().default(20),
})

export interface ContextModeConfig {
  routingEnabled: boolean
  denyCurlWget: boolean
  bashNudgeMinCommandBytes: number
  maxReadBytesBeforeAsk: number
  autoGuideRead: boolean
  readAllowBounded: boolean
  trustedReadBasenames: string[]
  trustedDocHeadroom: number
  executeEnabled: boolean
  executeDefaultLanguage: string
  executeAllowShell: boolean
  executeTimeoutMs: number
  executeConcurrency: number
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
}

/** 显式默认值：即便 loader 未对 config 应用 schema 默认，也用此兜底。 */
export const DEFAULT_CONFIG: ContextModeConfig = {
  routingEnabled: true,
  denyCurlWget: true,
  bashNudgeMinCommandBytes: 0,
  maxReadBytesBeforeAsk: 51200,
  autoGuideRead: true,
  readAllowBounded: true,
  trustedReadBasenames: ['README', 'CHANGELOG', 'LICENSE', 'AGENTS', 'package.json'],
  trustedDocHeadroom: 4,
  executeEnabled: true,
  executeDefaultLanguage: 'ts',
  executeAllowShell: false,
  executeTimeoutMs: 0,
  executeConcurrency: 4,
  knowledgeBaseDir: defaultKnowledgeDir,
  knowledgeBaseTtlMs: 86_400_000,
  knowledgeBaseConcurrency: 4,
  memoryCapture: false,
  memoryTtlMs: 7 * 86_400_000,
  memoryResumeTopN: 3,
  memoryResumeBytes: 800,
  adviceStructured: true,
  adviceRich: true,
  accountingLedger: false,
  sessionContinuity: true,
  continuityTopN: 20,
}
