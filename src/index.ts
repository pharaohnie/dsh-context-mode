// index.ts — context-mode 插件入口（M0 骨架 + M1 知识库工具）
// 相对导入一律带 .ts 后缀；erasable TS 语法（无 enum/namespace）
import { Config, DEFAULT_CONFIG, type ContextModeConfig } from './config.ts'
import { registerDoctor, type DoctorDeps } from './doctor.ts'
import { registerKnowledgeTools, SEARCH_BUDGET_BYTES } from './knowledge/tools.ts'
import { registerExecuteTools } from './knowledge/execute.ts'
import { registerMemory, captureMemory } from './knowledge/memory.ts'
import { openKnowledgeDb, incMeta, computeSavedBytes, type KnowledgeDb } from './knowledge/sqlite.ts'
import { registerGate } from './routing/gate.ts'
import { registerGuard } from './routing/guard.ts'
import { registerAdvice } from './routing/advice.ts'
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
}, rawConfig: Partial<ContextModeConfig>) {
  // 防御：loader 可能未对 config 应用 schema 默认，用显式 DEFAULT_CONFIG 兜底合并。
  const config: ContextModeConfig = { ...DEFAULT_CONFIG, ...rawConfig }
  console.log('[context-mode] apply 收到 config =', JSON.stringify(config))
  // 打开知识库（失败则降级：ctx_doctor 报告 + 知识库工具报错）
  let kdb: KnowledgeDb | null = null
  try {
    kdb = openKnowledgeDb(config.knowledgeBaseDir)
    console.log('[context-mode] 知识库已就绪:', kdb.file)
  } catch (e) {
    console.log('[context-mode] 知识库打开失败:', (e as Error).message)
    kdb = null
  }
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
  }
  registerDoctor(ctx, deps)
  // M1：知识库四工具
  registerKnowledgeTools(ctx, { kdb, config })
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
    },
    hasApproval,
    // 拒绝洪水的字节计入节约台账（curl/wget 命令串长度，persisted to knowledge db meta 表）
    recordDenied: (bytes) => {
      if (kdb) incMeta(kdb.db, 'denied_bytes', bytes)
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
    // deny 时一次性回流累计节约（低频事件，不常驻 prompt）
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
  // M3：会话连续性恢复（session-start 监听 + sessionQuery 检索 + agent.inject 注入）
  registerRestore(ctx, {
    config: {
      sessionContinuity: config.sessionContinuity,
      continuityTopN: config.continuityTopN,
      memoryCapture: config.memoryCapture,
      memoryTtlMs: config.memoryTtlMs,
      memoryResumeTopN: config.memoryResumeTopN,
      memoryResumeBytes: config.memoryResumeBytes,
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
  registerStats(ctx, { kdb })
}
