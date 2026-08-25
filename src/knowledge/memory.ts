// knowledge/memory.ts — 会话记忆捕获（可检索，复用 meta/chunks）+ 近期记忆查询
// 记忆类别 → ref 前缀：memory:user-prompt:<sid> / memory:decision:<sid> / memory:constraint:<sid> / memory:rejected-approach:<sid>
// B3：记忆捕获默认 opt-in（memoryCapture:false）；TTL 默认非 0（7d）控制生命周期；调用方须过滤插件合成消息 + subagent 会话。
import type { PluginEventEmitter } from '../types/dsh-events.ts'
import { addChunk, deleteByRef, deleteExpired, incMeta, type KnowledgeDb } from './sqlite.ts'
import { byteLen } from '../util/bytes.ts'

export const MEMORY_KINDS = ['user-prompt', 'decision', 'constraint', 'rejected-approach'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

// 进程级 seen-set 去重（decision/constraint/rejected-approach 防重复事件反复入账）
// P3-3：模块级单例、有界（SEEN_CAP=512，超出淘汰最旧）。它是「进程级幂等/去重」而非 per-apply 状态——
// 停在 stop/update 时保留以维持跨 apply 去重，但 cap 已约束内存，不会无限增长。
const seen = new Set<string>()
const SEEN_CAP = 512
function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 捕获一条会话记忆为可检索 chunk。`capture=false` 或 kdb 缺失 → 静默跳过（B3）。 */
export function captureMemory(kbd: KnowledgeDb | null, kind: MemoryKind, sid: string, text: string, capture: boolean, ttlMs: number): void {
  if (!capture || !kbd || !sid || !text) return
  const d = kbd.db
  const ref = `memory:${kind}:${sid}`
  // 去重：user-prompt 按 ref 替换（只留最近一条）；其它按 seen-set（防相同内容重复入账）
  if (kind === 'user-prompt') {
    try { deleteByRef(d, ref) } catch (e) { console.warn('[context-mode] memory 清理失败:', (e as Error).message) } // R5-2（B-08f）
  } else {
    const key = `${kind}:${sid}:${hash(text)}`
    if (seen.has(key)) return
    if (seen.size >= SEEN_CAP) { const o = seen.keys().next().value; if (o !== undefined) seen.delete(o) }
    seen.add(key)
  }
  try {
    addChunk(d, ref, kind, text, ttlMs)
    incMeta(d, 'memory_chunks', 1)
    incMeta(d, 'memory_bytes', byteLen(text))
  } catch (e) { console.warn('[context-mode] memory 写入失败:', (e as Error).message) } // R5-2（B-08f）
}

const RESUME_PREFIXES = ['memory:decision', 'memory:constraint', 'memory:user-prompt', 'memory:rejected-approach']

/** 拉本会话最近的决策/约束/用户提示/拒绝方案（按 ref 前缀 + created_at 降序，受 bytes 预算）。 */
export function queryRecentMemory(kbd: KnowledgeDb | null, sid: string, topN: number, bytes: number): string {
  if (!kbd || !sid) return ''
  const d = kbd.db
  try { deleteExpired(d) } catch { /* 忽略 */ }
  const prefixes = RESUME_PREFIXES.map((p) => `${p}:${sid}`)
  const where = prefixes.map(() => 'ref LIKE ?').join(' OR ')
  const rows: { ref: string; title: string; body: string }[] = []
  try {
    const stmt = d.prepare(`SELECT ref, title, body FROM chunks WHERE (${where}) ORDER BY created_at DESC LIMIT ?`)
    rows.push(...(stmt.all(...prefixes.map((p) => p + '%'), topN) as { ref: string; title: string; body: string }[]))
  } catch { /* 查询失败返回空 */ }
  let out = ''
  let used = 0
  for (const r of rows) {
    const line = `- [${r.title}] ${r.body.slice(0, 300)}`
    if (used + line.length > bytes) break
    out += line + '\n'
    used += line.length
  }
  return out.trim()
}

export interface MemoryRegisterDeps {
  config: { memoryCapture: boolean; memoryTtlMs: number }
  kdb: KnowledgeDb | null
  sessionQuery?: { filterEvents?: (id: string, f: unknown[]) => Promise<unknown[]> }
}

function textOfMessage(message: { content?: unknown }): string {
  const c = message?.content
  if (!Array.isArray(c)) return ''
  return c.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
}

/** 注册会话记忆捕获监听：user-prompt（agent/inbox/inserted）+ decision/constraint（agent/turn-stopping）。
 *  仅 memoryCapture=true 时生效；过滤 subagent 会话 + 插件合成消息（B3）；事件不存在/依赖缺失 → 静默降级。 */
export function registerMemory(ctx: PluginEventEmitter, deps: MemoryRegisterDeps) {
  if (!deps.config.memoryCapture) return
  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const agent = payload?.agent
      const message = payload?.message
      if (!agent || !message) return
      if (agent.session?.header?.origin === 'subagent' || agent.session?.header?.parentSession !== undefined) return
      if (message.source?.kind === 'plugin') return
      const sid: string = agent.id
      if (!sid) return
      const text = textOfMessage(message)
      if (!text) return
      captureMemory(deps.kdb, 'user-prompt', sid, text, deps.config.memoryCapture, deps.config.memoryTtlMs)
    } catch { /* 静默 */ }
  })
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || agent.session?.header?.origin === 'subagent' || agent.session?.header?.parentSession !== undefined) return
      const sid: string = agent.id
      if (!sid) return
      const sq = deps.sessionQuery
      if (!sq || typeof sq.filterEvents !== 'function') return
      const evs = (await sq.filterEvents(sid, [
        { kind: 'type', values: ['assistant/message'] },
        { kind: 'surface', values: ['current'] },
      ])) as { text?: string }[]
      if (!evs.length) return
      const last = evs[evs.length - 1]
      const text = typeof last.text === 'string' ? last.text : ''
      if (!text) return
      // R5-9（D-M4）降级标注：关键词启发式识别「决策/约束」，非精确语义判定——误判/漏判已知（技术对话中「方案/限制/不再」高频）；
      // 已在 doctor/README 如实标注为启发式；如需精确决策识别建议改为显式结构化 schema。
      if (/(决定|决策|记住|约束|需要保留|不再|方案|限制)/.test(text)) {
        const kind = /(约束|限制|不再|需要保留)/.test(text) ? 'constraint' : 'decision'
        captureMemory(deps.kdb, kind, sid, text.slice(0, 600), deps.config.memoryCapture, deps.config.memoryTtlMs)
      }
    } catch { /* 静默 */ }
  })
}
