// index.ts — context-mode 插件入口（M0 骨架 + M1 知识库工具）
// 相对导入一律带 .ts 后缀；erasable TS 语法（无 enum/namespace）
import { writeFileSync } from 'node:fs'
import { DEFAULT_CONFIG, envConfigOverrides, type ContextModeConfig } from './config.ts'
// 合规修复（报告问题1）：按官方「插件配置」页要求，从入口导出同名 Schemastery Config schema，
// loader 据此校验配置并填充未提供字段的默认值（此前仅 import 未导出，该机制整体空转）。
export { Config } from './config.ts'
import { registerDoctor, type DoctorDeps } from './doctor.ts'
import { registerKnowledgeTools, SEARCH_BUDGET_BYTES } from './knowledge/tools.ts'
import { registerExecuteTools } from './knowledge/execute.ts'
import { registerMemory, captureMemory } from './knowledge/memory.ts'
import { openKnowledgeDb, incMeta, computeSavedBytes, type KnowledgeDb } from './knowledge/sqlite.ts'
import { createFloodGuard } from './knowledge/flood-guard.ts'
import { registerGate } from './routing/gate.ts'
import { registerGuard } from './routing/guard.ts'
import { registerAdvice } from './routing/advice.ts'
import { registerSkill } from './knowledge/skill.ts'
import { registerRestore } from './continuity/restore.ts'
import { registerStats } from './continuity/stats.ts'

export const name = 'context-mode'

// 硬依赖：tools（工具注册/pre-execute/guard）、systemPrompt（section）
// 可选：sessionQuery/tokenMeter/sessions/approval 经 ctx.get，缺失降级不阻塞（I3）
export const inject = ['tools', 'systemPrompt']

// P3-4：此 ctx 是官方 @deepseek-ai/cordis 的 `Context` 的**窄化字面量**（插件只声明所用键 tools/systemPrompt/on/get，
// 保持 erasable-TS 无装饰器、无需完整 cordis 类型 import）。完整类型可换 `import type { Context } from '@deepseek-ai/cordis'`；
// 工具 execute 的 `exec` 对应 `ToolRunContext`（此处用 `any` 以便跨工具复用，保持与 defineTool 实际运行时一致）。
export function apply(ctx: {
  tools: { register(def: unknown): unknown; guard(fn: (exec: unknown) => string | undefined): unknown }
  systemPrompt: { section(s: unknown): unknown }
  on(event: string, listener: (...a: never[]) => unknown): void
  get(name: string): unknown
  // 合规修复（报告问题2）：手动清理的资源用 ctx.effect 注册处置器（官方「第一个插件」/「生命周期」页）
  effect(fn: () => (() => void) | void): unknown
}, rawConfig: Partial<ContextModeConfig>) {
  // 【临时观测 · 修改一 1a】判定导出 Config 后 loader 是否应用 schema 默认值：
  // rawConfig 稀疏（少量键）= 不填充（作者实测结论仍成立）；完整（全部 schema 键）= 填充生效。
  // 观测完成后连同顶部 writeFileSync import 一并移除（见 COMPLIANCE_FIX_PLAN.md 修改一）。
  try {
    const raw: Record<string, unknown> = rawConfig ?? {}
    writeFileSync('/tmp/context-mode-rawconfig.json', JSON.stringify({
      observedAt: new Date().toISOString(),
      keyCount: Object.keys(raw).length,
      hasRoutingEnabled: Object.prototype.hasOwnProperty.call(raw, 'routingEnabled'),
      routingEnabledValue: raw.routingEnabled ?? null,
      keys: Object.keys(raw),
    }, null, 2))
  } catch { /* 观测失败不影响插件运行 */ }
  // 防御：loader 可能未对 config 应用 schema 默认，用显式 DEFAULT_CONFIG 兜底合并。
  // P3-1：env 覆盖插在 DEFAULT_CONFIG 与 rawConfig 之间（优先级 rawConfig > env > 默认）。
  const config: ContextModeConfig = { ...DEFAULT_CONFIG, ...envConfigOverrides(), ...rawConfig }
  // R2-4（D-H1）：maxReadDenyBytes（语义对齐新键）优先；旧 maxReadBytesBeforeAsk 保留为 deprecated 兼容键。
  if (config.maxReadDenyBytes !== undefined) config.maxReadBytesBeforeAsk = config.maxReadDenyBytes
  // R5-3（D-L4）：只打印摘要（enabled flags + db 路径），不整包刷配置（避免策略/路径泄露与日志噪音）
  console.log(`[context-mode] apply: routing=${config.routingEnabled} execute=${config.executeEnabled} shell=${config.executeAllowShell} memory=${config.memoryCapture} continuity=${config.sessionContinuity} kdb=${config.knowledgeBaseDir}`)
  // 打开知识库（失败则降级：ctx_doctor 报告 + 知识库工具报错）
  let kdb: KnowledgeDb | null = null
  try {
    kdb = openKnowledgeDb(config.knowledgeBaseDir)
    console.log('[context-mode] 知识库已就绪:', kdb.file)
    // 合规修复（报告问题2）：DB 连接随插件 fiber 生命周期关闭（卸载/HMR/禁用时）；
    // 多次 close 会抛错，try-catch 吞掉；并发窗口由 busy_timeout=5000 兜底。
    const opened = kdb
    ctx.effect(() => () => {
      try { opened.db.close() } catch { /* 已关闭 */ }
    })
  } catch (e) {
    console.log('[context-mode] 知识库打开失败:', (e as Error).message)
    kdb = null
  }
  // P1：搜索 FloodGuard 单例（per-agent-context 分桶）——同时供 ctx_search 节流与 ctx_doctor 观测
  const floodGuard = createFloodGuard(config.searchWindowMs, config.searchMaxResultsAfter, config.searchBlockAfter)
  const deps: DoctorDeps = {
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    sessionQuery: ctx.get('sessionQuery'),
    tokenMeter: ctx.get('tokenMeter'),
    sessions: ctx.get('sessions'),
    approval: ctx.get('approval'),
    kdb,
    config,
    codeRuntime: ctx.get('codeRuntime'),
    fs: ctx.get('fs'),
    shell: ctx.get('shell'),
    sandboxPolicy: ctx.get('sandboxPolicy'),
    floodGuard,
  }
  registerDoctor(ctx, deps)
  // M1：知识库四工具
  registerKnowledgeTools(ctx, { kdb, config: { knowledgeBaseTtlMs: config.knowledgeBaseTtlMs, knowledgeBaseConcurrency: config.knowledgeBaseConcurrency, searchWindowMs: config.searchWindowMs, searchMaxResultsAfter: config.searchMaxResultsAfter, searchBlockAfter: config.searchBlockAfter, maxSourceBytes: config.maxSourceBytes }, floodGuard })
  // P0：沙箱执行三工具（复用 DSH codeRuntime；把 config 里的 execute* 传过去）
  registerExecuteTools(ctx, { kdb, config })
  // M2：路由强制（host 全局注册；fail-open 用 ctx.get('approval') 探测）
  const hasApproval = () => ctx.get('approval') !== undefined
  // read_denied_bytes 按 file_path 去重（同一文件只计一次，避免重复被拒让 saved 虚增）
  // P3-3：模块级单例、有界（同一 file_path 只记一次，重启动前会保留以维持去重；非 per-apply 状态，cap 对应「去重」而非「无限增长」）。
  const deniedReadFiles = new Set<string>()
  registerGate(ctx, {
    config: {
      routingEnabled: config.routingEnabled,
      denyCurlWget: config.denyCurlWget,
      bashNudgeMinCommandBytes: config.bashNudgeMinCommandBytes,
      readAllowBounded: config.readAllowBounded,
      autoGuideRead: config.autoGuideRead,
      maxReadBytesBeforeAsk: config.maxReadBytesBeforeAsk,
      trustedReadBasenames: config.trustedReadBasenames,
      trustedDocHeadroom: config.trustedDocHeadroom,
      executeEnabled: config.executeEnabled,
      executeAllowShell: config.executeAllowShell,
      executeDefaultLanguage: config.executeDefaultLanguage,
      boundedWhitelist: config.boundedWhitelist,
      securityEnabled: config.securityEnabled,
      securityAllowGlobs: config.securityAllowGlobs,
      securityDenyGlobs: config.securityDenyGlobs,
    },
    hasApproval,
    // 拒绝洪水的字节计入节约台账（curl/wget 命令串长度，persisted to knowledge db meta 表）
    recordDenied: (bytes) => {
      if (kdb) incMeta(kdb.db, 'denied_bytes', bytes)
    },
    // 洪水被改道（redirect 分类）—— vs 拒绝：redirect 是「避开的上下文冲击」下界（P0-1 度量）
    recordRedirect: (bytes) => {
      if (kdb) incMeta(kdb.db, 'redirect_bytes', bytes)
    },
    // read 被拒的真实拦截字节（stat.size），按 file_path 去重，记入独立键 read_denied_bytes
    recordDeniedRead: (size, filePath) => {
      if (!kdb || !filePath || deniedReadFiles.has(filePath)) return
      deniedReadFiles.add(filePath)
      incMeta(kdb.db, 'read_denied_bytes', size)
    },
    // deny 时上报 rejected-approach 记忆（P1b；低频，按 deny reason 去重）
    recordRejected: (sid, reason) => {
      if (kdb) captureMemory(kdb, 'rejected-approach', sid, reason, config.memoryCapture, config.memoryTtlMs)
    },
    // rejected 分类记账（P0-1）：deny reason 文本长度下界
    recordRejectedBytes: (bytes) => {
      if (kdb) incMeta(kdb.db, 'rejected_bytes', bytes)
    },
    // deny 时一次性回流累计节约（低频事件，不常驻 prompt）
    // P2-2 节流：同会话同类别只回流一次（guidanceOnce），避免每次 deny 都查库算节约刷屏。
    contextNote: () => {
      if (!kdb) return undefined
      try {
        const { saved } = computeSavedBytes(kdb.db)
        return `本会话累计节约 ${saved} 字节（≈${Math.round(saved / 4)} tokens）。`
      } catch { return undefined }
    },
  })
  registerGuard(ctx, {
    config: {
      routingEnabled: config.routingEnabled,
      denyCurlWget: config.denyCurlWget,
      executeEnabled: config.executeEnabled,
      executeAllowShell: config.executeAllowShell,
    },
  })
  registerAdvice(ctx, {
    enabled: config.routingEnabled,
    maxReadBytesBeforeAsk: config.maxReadBytesBeforeAsk,
    budgetBytes: SEARCH_BUDGET_BYTES,
    trustedReadBasenames: config.trustedReadBasenames,
    adviceStructured: config.adviceStructured,
    adviceRich: config.adviceRich,
    executeDefaultLanguage: config.executeDefaultLanguage,
  })
  // P1-1：注册可软触发的 context-mode skill（DSH skills 可选；缺失降级到 advice 常驻 section）
  registerSkill(ctx, { enabled: config.routingEnabled, config }) // R4-2：传阈值供 SKILL 文本参数化
  // M3：会话连续性恢复（session-start 监听 + sessionQuery 检索 + agent.inject 注入）
  registerRestore(ctx, {
    config: {
      sessionContinuity: config.sessionContinuity,
      continuityTopN: config.continuityTopN,
      memoryCapture: config.memoryCapture,
      memoryTtlMs: config.memoryTtlMs,
      memoryResumeTopN: config.memoryResumeTopN,
      memoryResumeBytes: config.memoryResumeBytes,
      subagentGuidance: config.subagentGuidance,
      maxReadBytesBeforeAsk: config.maxReadBytesBeforeAsk, // R4-2：子代理守卫阈值参数化
    },
    kdb,
  })
  // P1b：会话记忆捕获（user-prompt via inbox/inserted + decision/constraint via turn-stopping；B3 opt-in）
  registerMemory(ctx, {
    config: { memoryCapture: config.memoryCapture, memoryTtlMs: config.memoryTtlMs },
    kdb,
    sessionQuery: ctx.get('sessionQuery') as { filterEvents?: (id: string, f: unknown[]) => Promise<unknown[]> } | undefined,
  })
  // M4：ctx_stats（节约台账 + tokenMeter 压力）
  registerStats(ctx, { kdb, accountingLedger: config.accountingLedger })
}
