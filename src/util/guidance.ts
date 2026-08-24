// util/guidance.ts — 引导节流（P2-2，对齐官方 guidanceOnce / guidancePeriodic）
// 目的：deny/ask 的 reason 每次事件都回传，重复洪水会刷屏；官方用「每会话每类型一次 + 每 N 次重注入」节流。
// 实现：进程内 Map 去重（once）+ 可选 tmpdir 原子标记文件（跨 compaction 持久，O_EXCL 防并发）+ 周期计数器（periodic）。
// 本库保持纯逻辑、可注入（env/fs 可替换，便于测试与非 Node 探测）。

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** 每类型一次：返回 true 表示「应给予完整引导」（首次），false 表示「该类型已引导过、可折叠/静默」。
 *  memory 标记可持久到 tmpdir（key 落到 {tmp}/context-mode-guidance-<scope>/<type> 文件），防进程重启/compaction 后丢失。 */
export function guidanceOnce(type: string, scope: string, opts: { persist?: boolean; tmpdir?: string } = {}): boolean {
  const memKey = `${scope}:${type}`
  if (onceSet.has(memKey)) return false
  onceSet.add(memKey)
  if (onceSet.size > ONCE_CAP) { const o = onceSet.keys().next().value; if (o !== undefined) onceSet.delete(o) }
  if (opts.persist !== false) {
    try {
      const dir = path.join(opts.tmpdir ?? os.tmpdir(), 'context-mode-guidance', safe(scope))
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${safe(type)}.once`)
      // O_EXCL 原子创建：已存在则说明该类型本会话/本进程已引导过（跨 compaction 持久）
      const fd = fs.openSync(file, 'wx')
      fs.closeSync(fd)
      return true
    } catch { /* 已存在或无法创建 → 仍以内存去重为准 */ }
  }
  return true
}

/** 每 N 次重注入：返回 true 表示「该周期应重注入引导」（(counter-1) % period === 0），false 表示跳过。
 *  官方 guidancePeriodic 用来防止 compaction 后引导丢失；period<=0 关闭。 */
export function guidancePeriodic(counter: number, period: number): boolean {
  if (period <= 0) return false
  return (counter - 1) % period === 0
}

const onceSet = new Set<string>()
const ONCE_CAP = 512
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_')
