// continuity/restore.ts — agent/session-start 监听 + 检索 + 蒸馏 + agent.inject 注入
// 要点：H2 subagent 过滤（origin==='subagent' || parentSession）、判别联合 filterEvents（AND，已确认 every()）、
//       压缩地板（compaction/summary|prune 只取 seq，因 extractSessionEventText 对其回空串）、
//       幂等去重（进程内指纹）、agent.inject 构造完整 UserMessage。
import { distillEvents, fingerprintOf, type DistillEvent } from './distillation.ts'
import { queryRecentMemory } from '../knowledge/memory.ts'
import { type KnowledgeDb } from '../knowledge/sqlite.ts'

const restoredFingerprints = new Map<string, string>()
const FINGERPRINT_CAP = 256 // 宿主任期保护：限制进程级指纹 Map 大小，超出淘汰最旧，防无界增长

export interface RestoreDeps {
  config: { sessionContinuity: boolean; continuityTopN: number; memoryCapture: boolean; memoryTtlMs: number; memoryResumeTopN: number; memoryResumeBytes: number }
  kdb: KnowledgeDb | null
}

const P1_P2_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result']
const COMPACTION_TYPES = ['compaction/summary', 'compaction/prune']

export function registerRestore(ctx: {
  on(event: string, listener: (...a: never[]) => unknown): void
  get(name: string): unknown
}, deps: RestoreDeps) {
  if (!deps.config.sessionContinuity) return
  ctx.on('agent/session-start' as never, async (payload: any) => {
    const agent = payload?.agent
    if (!agent) return
    // H2：subagent 会话不注入恢复上下文（污染子代理）
    if (agent.origin === 'subagent' || agent.parentSession !== undefined) return
    const sid: string = agent.sessionId
    if (!sid) return
    const sq = ctx.get('sessionQuery') as { filterEvents?: (id: string, f: unknown[]) => Promise<unknown[]> } | undefined
    if (!sq || typeof sq.filterEvents !== 'function') return
    if (typeof agent.inject !== 'function') return
    try {
      // 压缩地板：最后一次 compaction/summary|prune 的 seq（text 为空，只需 seq）
      const comp = (await sq.filterEvents(sid, [{ kind: 'type', values: COMPACTION_TYPES }])) as { seq: number }[]
      const floor = comp.length ? Math.max(...comp.map((e) => e.seq)) : -1
      // 最近 current 事件（type + surface:'current'，AND）
      const evs = (await sq.filterEvents(sid, [
        { kind: 'type', values: P1_P2_TYPES },
        { kind: 'surface', values: ['current'] },
      ])) as DistillEvent[]
      const recent = evs.filter((e) => e.seq > floor).slice(-deps.config.continuityTopN)
      const body = distillEvents(recent)
      if (!body) return
      let summary = floor >= 0 ? `（此前内容已压缩，以下为最近工作状态）\n${body}` : body
      // P1c：memoryCapture=true 时注入「先搜再问」+ 近期记忆（B3：依赖记忆捕获开启；否则回退蒸馏注入）
      if (deps.config.memoryCapture && deps.kdb && sid) {
        const mem = queryRecentMemory(deps.kdb, sid, deps.config.memoryResumeTopN, deps.config.memoryResumeBytes)
        if (mem) {
          summary = `【会话记忆】恢复前请先 ctx_search(sort:"timeline", source:["memory:decision","memory:constraint","memory:user-prompt","memory:rejected-approach"]) 检索本会话最近决策/约束；再向用户提问，不要重复已决定事项。\n近期记忆：\n${mem}\n\n${summary}`
        }
      }
      // 幂等去重（进程内指纹，避免重复 session-start 重复注入）
      const fp = fingerprintOf(summary)
      if (restoredFingerprints.get(sid) === fp) return
      if (restoredFingerprints.size >= FINGERPRINT_CAP) {
        const oldest = restoredFingerprints.keys().next().value
        if (oldest !== undefined) restoredFingerprints.delete(oldest)
      }
      restoredFingerprints.set(sid, fp)
      // 注入：完整 UserMessage（id/content/source）
      agent.inject({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'plugin', plugin: 'context-mode' },
      })
    } catch {
      // 恢复失败静默降级，不阻塞会话启动
    }
  }) as never
}
