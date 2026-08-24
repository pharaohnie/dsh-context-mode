// knowledge/flood-guard.ts — 搜索 FloodGuard：per-agent-context 分桶时间窗节流（P1）
// 对齐官方 build/search/flood-guard.js 的修复意图（#769：多子代理并行不互相误伤）。
// 官方是 class；本项目 erasableSyntaxOnly 且库内偏好闭包（tools.ts 旧实现同风格），故用工厂函数 + 闭包桶。
// 纯逻辑、零依赖（不 import dsh-tools/sqlite），可独立单测（node 直跑）。
// 语义与原单桶一致：窗口内前 maxAfter 次检索放行；之后 taper（减少返回条数）；到 blockAfter 次后硬 block。
// 差别：预算按 key（agent-context）分桶，互不共享；超 maxKeys 淘汰最旧桶（fail-open，不误伤）。

export type FloodGate = 'ok' | 'taper' | 'block'

export interface FloodGuardBucket { key: string; count: number; ageMs: number }

export interface FloodGuardSnapshot {
  windowMs: number
  maxAfter: number
  blockAfter: number
  maxKeys: number
  disabled: boolean
  buckets: FloodGuardBucket[]
}

export interface FloodGuard {
  /** 记录一次检索调用，返回本次判定。key = agent-context（如 exec.agent.sessionId）。 */
  record(key: string, now?: number): FloodGate
  /** 只读快照（供 ctx_doctor / 测试观测；不泄露完整 key，由调用方截断展示）。 */
  snapshot(): FloodGuardSnapshot
}

/**
 * 创建分桶 FloodGuard。windowMs<=0 或 blockAfter<=0 → disabled（恒 ok，保留关闭语义）。
 * maxKeys 为防御性上限：桶数超出时淘汰窗口最旧的桶（被淘汰者下次调用得新窗口，fail-open）。
 */
export function createFloodGuard(windowMs = 60_000, maxAfter = 3, blockAfter = 8, maxKeys = 4096): FloodGuard {
  const buckets = new Map<string, number[]>()
  const disabled = windowMs <= 0 || blockAfter <= 0

  /** 淘汰最旧窗口的桶（超上限时）。 */
  const evictIfNeeded = () => {
    if (buckets.size <= maxKeys) return
    let oldestKey: string | undefined
    let oldestStart = Infinity
    for (const [k, calls] of buckets) {
      const start = calls[0] ?? Infinity
      if (start < oldestStart) { oldestStart = start; oldestKey = k }
    }
    if (oldestKey !== undefined) buckets.delete(oldestKey)
  }

  const record = (key: string, now = Date.now()): FloodGate => {
    if (disabled) return 'ok'
    const k = key || 'default'
    let calls = buckets.get(k)
    if (!calls || now - calls[0] > windowMs) {
      // 新桶或窗口过期 → 重置（新窗口）
      calls = [now]
      buckets.set(k, calls)
      evictIfNeeded()
    } else {
      calls.push(now)
    }
    while (calls.length && now - calls[0] > windowMs) calls.shift()
    if (blockAfter > 0 && calls.length > blockAfter) return 'block'
    if (maxAfter > 0 && calls.length > maxAfter) return 'taper'
    return 'ok'
  }

  const snapshot = (now = Date.now()): FloodGuardSnapshot => {
    const bucketList: FloodGuardBucket[] = []
    for (const [key, calls] of buckets) {
      bucketList.push({ key, count: calls.length, ageMs: now - (calls[0] ?? now) })
    }
    bucketList.sort((a, b) => b.count - a.count || a.ageMs - b.ageMs)
    return { windowMs, maxAfter, blockAfter, maxKeys, disabled, buckets: bucketList }
  }

  return { record, snapshot }
}
