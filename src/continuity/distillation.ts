// continuity/distillation.ts — 轻量 P1/P2 事件蒸馏（不照搬上游 109KB extract.ts）
// 输出一段紧凑恢复摘要；last-prompt（最近用户意图）必恢复。
export interface DistillEvent { seq: number; type: string; text: string }

// P3-2：恢复摘要字节上限（控制注入上下文体积），定位为内部常量，非部署差异点。
const MAX_SUMMARY_BYTES = 2000

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return 'h' + (h >>> 0).toString(36)
}

/** 蒸馏事件为恢复摘要；无可用信息时返回 null。 */
export function distillEvents(events: DistillEvent[]): string | null {
  if (!events.length) return null
  const parts: string[] = []
  // P1 last-prompt —— 最近用户意图必恢复
  const user = events.filter((e) => e.type === 'user/message').map((e) => e.text)
  const lastPrompt = user.at(-1)
  if (lastPrompt) parts.push(`最近用户意图：${truncate(lastPrompt)}`)
  // P2 最近错误
  const errors = events.filter((e) => e.type === 'tool/result' && /error|failed|exception|错误|失败/i.test(e.text)).map((e) => e.text).slice(-2)
  for (const e of errors) parts.push(`错误：${truncate(e)}`)
  // P2 最近文件路径
  const files = events.filter((e) => e.type === 'tool/result')
    .flatMap((e) => e.text.match(/[\w./.-]+\.(?:ts|js|py|md|json|ya?ml|txt|sh|go|rs|java|c|h|css|html|vue)\b/gi) ?? [])
    .slice(-4)
  if (files.length) parts.push(`最近文件：${[...new Set(files)].join(', ')}`)
  // 最近进度 / 决策（最后一条 assistant 消息）
  const lastActivity = events.filter((e) => e.type === 'assistant/message').map((e) => e.text).at(-1)
  if (lastActivity) parts.push(`最近进度：${truncate(lastActivity)}`)
  // 最近工具活动
  const tools = events.filter((e) => e.type === 'tool/call').map((e) => e.text.split('\n')[0]).filter(Boolean).slice(-4)
  if (tools.length) parts.push(`最近工具：${[...new Set(tools)].join(', ')}`)
  if (!parts.length) return null
  let summary = '【context-mode 会话恢复】\n' + parts.join('\n')
  if (summary.length > MAX_SUMMARY_BYTES) summary = summary.slice(0, MAX_SUMMARY_BYTES) + '…'
  return summary
}

export function fingerprintOf(summary: string): string { return hash(summary) }

function truncate(s: string, n = 120): string {
  s = s.trim().replace(/\s+/g, ' ')
  return s.length > n ? s.slice(0, n) + '…' : s
}
