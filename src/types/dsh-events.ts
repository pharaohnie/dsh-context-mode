// types/dsh-events.ts - P1-2：本插件所用 DSH 事件的本地显式类型。
// 官方包经 declare module '@deepseek-ai/cordis' 提供 Events 增强，但在 pnpm 隔离 +
// skipLibCheck 工具链下该增强对消费方 .ts 不可靠（tsc 5.9.3 实测，--listFilesOnly 佐证），
// 故按官方签名显式声明（签名逐一对照 @deepseek-ai/dsh-tools/lib/types/index.d.ts:38 与
// @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:180/220/301），获得编译期
// 事件名与 payload 校验，替代 as never 断言。payload 的 agent 字段直接复用官方 Agent
// 类型（id/session.header/inject 均受官方契约约束）。

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** tools/pre-execute 监听器（瀑布）：放行必 return next()，短路返回 deny/ask 决策。 */
export type PreExecuteListener = (
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>

/** agent/inbox/inserted payload（message 取窄化视图：仅声明本插件消费的字段）。 */
export interface InboxPayload {
  agent: Agent
  message: { content?: unknown; source?: { kind?: string; plugin?: string } }
}

/** agent/session-start payload（source 为会话启动来源，本插件未消费）。 */
export interface SessionStartPayload {
  agent: Agent
  source: unknown
}

/** agent/turn-stopping payload。 */
export interface TurnStoppingPayload {
  agent: Agent
  turn: number
  signal: AbortSignal
}

/** 插件侧事件注册器：仅覆盖本插件使用的四个事件（事件名字面量校验，拼写错误编译期报错）。 */
export interface PluginEventEmitter {
  on(name: 'tools/pre-execute', listener: PreExecuteListener): unknown
  on(name: 'agent/inbox/inserted', listener: (payload: InboxPayload) => void): unknown
  on(name: 'agent/session-start', listener: (payload: SessionStartPayload) => void | Promise<void>): unknown
  on(name: 'agent/turn-stopping', listener: (payload: TurnStoppingPayload) => void | Promise<void>): unknown
}
