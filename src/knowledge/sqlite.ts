// knowledge/sqlite.ts — 知识库后端：node:sqlite + FTS5 外部内容双表 + 存储层
// 标题 5x 用 bm25(t, 5.0, 1.0) 列权重；RRF 合并；TTL 惰性失效。
// FTS 外部内容表与 chunks 表通过 rowid 同步（实测通过），删除用 'delete'，清库用 'rebuild'。
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

// P3-2：RRF 合并常数（检索排名的 k=60，业界常见），定位为内部算法常量、非部署差异点。
const RRF_K = 60

export interface KnowledgeChunk { id: number; ref: string; title: string; body: string; created_at: number; ttl_ms: number }

/** 建 schema（幂等）：chunks 内容表 + FTS5 双列双表（external content）。 */
export function createSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_porter
      USING fts5(title, body, content='chunks', content_rowid='id', tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram
      USING fts5(title, body, content='chunks', content_rowid='id', tokenize='trigram');
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)
}

export interface KnowledgeDb { db: DatabaseSync; file: string }

/** 打开（必要时创建）知识库；目录可配，默认 ~/.context-mode/content。 */
export function openKnowledgeDb(dir: string): KnowledgeDb {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'content.db')
  const db = new DatabaseSync(file)
  createSchema(db)
  return { db, file }
}

/** 写入一个 chunk（chunks + 两个 FTS 表同步）。 */
export function addChunk(db: DatabaseSync, ref: string, title: string, body: string, ttlMs: number, now = Date.now()) {
  const id = Number(db.prepare('INSERT INTO chunks(ref,title,body,created_at,ttl_ms) VALUES(?,?,?,?,?)').run(ref, title, body, now, ttlMs).lastInsertRowid)
  db.prepare('INSERT INTO chunks_porter(rowid,title,body) VALUES(?,?,?)').run(id, title, body)
  db.prepare('INSERT INTO chunks_trigram(rowid,title,body) VALUES(?,?,?)').run(id, title, body)
  return id
}

/** 清空所有 chunk（含 FTS 同步）。 */
export function purgeChunks(db: DatabaseSync): number {
  const n = (db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n
  db.exec('DELETE FROM chunks')
  db.exec("INSERT INTO chunks_porter(chunks_porter) VALUES('rebuild')")
  db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('rebuild')")
  return n
}

/** 惰性删除已过期 chunk。 */
export function deleteExpired(db: DatabaseSync, now = Date.now()): number {
  const rows = db.prepare('SELECT id FROM chunks WHERE created_at + ttl_ms <= ?').all(now) as { id: number }[]
  for (const { id } of rows) {
    db.prepare('INSERT INTO chunks_porter(chunks_porter,rowid,title,body) VALUES(?,?,?,?)').run('delete', id, null, null)
    db.prepare('INSERT INTO chunks_trigram(chunks_trigram,rowid,title,body) VALUES(?,?,?,?)').run('delete', id, null, null)
    db.prepare('DELETE FROM chunks WHERE id = ?').run(id)
  }
  return rows.length
}

/** 按来源 ref 删除所有 chunk（replace-on-index：重索引前先删旧，避免 db 随重复索引增长）。 */
export function deleteByRef(db: DatabaseSync, ref: string): number {
  const rows = db.prepare('SELECT id FROM chunks WHERE ref = ?').all(ref) as { id: number }[]
  for (const { id } of rows) {
    db.prepare('INSERT INTO chunks_porter(chunks_porter,rowid,title,body) VALUES(?,?,?,?)').run('delete', id, null, null)
    db.prepare('INSERT INTO chunks_trigram(chunks_trigram,rowid,title,body) VALUES(?,?,?,?)').run('delete', id, null, null)
    db.prepare('DELETE FROM chunks WHERE id = ?').run(id)
  }
  return rows.length
}

/** 累加 meta 计数器（UPSERT）。 */
export function incMeta(db: DatabaseSync, key: string, delta: number) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  const cur = row ? Number(row.value) : 0
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(cur + delta))
}

/** 读 meta 计数器。 */
export function getMeta(db: DatabaseSync, key: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? Number(row.value) : 0
}

/** 修正口径的节约台账（S7）：measured_saved 仅 read 侧检测口径（read_denied_bytes，唯一精确「本应进入上下文」）；
 *  entered = search_bytes + execute_log_bytes（实际进入/返还）；kept_out_pct_measured 只反映 read 侧，不代表全量节约。
 *  kept_out_pct_total 含 estimate/下界（indexed-search 粗差 + denied_bytes 命令串下界），与之并列展示。 */
export function computeSavedBytes(db: DatabaseSync): {
  indexed: number
  search: number
  readDenied: number
  cmdDenied: number
  executeLog: number
  saved: number
  measuredSaved: number
  entered: number
  keptOutMeasured: number
  keptOutTotal: number
} {
  const indexed = getMeta(db, 'indexed_bytes')
  const search = getMeta(db, 'search_bytes')
  const readDenied = getMeta(db, 'read_denied_bytes')
  const cmdDenied = getMeta(db, 'denied_bytes')
  const executeLog = getMeta(db, 'execute_log_bytes')
  const saved = Math.max(0, indexed - search) + readDenied + cmdDenied
  const measuredSaved = readDenied // read 侧检测口径
  const entered = search + executeLog
  const keptOutMeasured = measuredSaved + entered > 0 ? (measuredSaved / (measuredSaved + entered)) * 100 : 0
  const keptOutTotal = saved + entered > 0 ? (saved / (saved + entered)) * 100 : 0
  return { indexed, search, readDenied, cmdDenied, executeLog, saved, measuredSaved, entered, keptOutMeasured, keptOutTotal }
}

/** 取体文本（M1 命中片段用）。 */
function getSnippet(body: string, terms: string[], window = 40): string {  const lower = body.toLowerCase()
  let best = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (best === -1 || i < best)) best = i
  }
  const start = best === -1 ? 0 : Math.max(0, best - window)
  const end = best === -1 ? window * 2 : Math.min(body.length, best + window)
  let s = body.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) s = '…' + s
  if (end < body.length) s = s + '…'
  return s
}

export interface SearchHit { id: number; ref: string; title: string; snippet: string; score: number }
export interface SearchOptions { query: string; topN: number; budgetBytes: number; now?: number; sort?: 'relevance' | 'timeline'; source?: string[] }

/** RRF 合并 porter/trigram 两个排名列表，返回命中片段（受字节预算约束）。
 *  sort: 'relevance'（默认，RRF score 降序）| 'timeline'（created_at 降序，最新在前）。
 *  source: ref 前缀过滤（数组为 OR），缺省不过滤。 */
export function searchChunks(db: DatabaseSync, opts: SearchOptions): SearchHit[] {
  const now = opts.now ?? Date.now()
  const terms = opts.query.split(/\s+/).filter((t) => t.length > 0)
  const rank = (table: string): Map<number, number> => {
    const m = new Map<number, number>()
    try {
      const rows = db.prepare(
        `SELECT ${table}.rowid AS id, bm25(${table}, 5.0, 1.0) AS s
         FROM ${table} JOIN chunks c ON c.id = ${table}.rowid
         WHERE ${table} MATCH ? AND c.created_at + c.ttl_ms > ?
         ORDER BY s LIMIT 200`,
      ).all(opts.query, now) as { id: number }[]
      rows.forEach((r, i) => m.set(r.id, i))
    } catch { /* MATCH 语法非法时整表不参与 RRF，不抛给模型 */ }
    return m
  }
  const porter = rank('chunks_porter')
  const trigram = rank('chunks_trigram')
  const merged = new Map<number, number>()
  const push = (id: number, r: number) => merged.set(id, (merged.get(id) ?? 0) + 1 / (RRF_K + r + 1))
  for (const [id, r] of porter) push(id, r)
  for (const [id, r] of trigram) push(id, r)
  const source = opts.source && opts.source.length ? opts.source : undefined
  const getChunk = db.prepare('SELECT id, ref, title, body, created_at FROM chunks WHERE id = ?')
  const chunkMap = new Map<number, { id: number; ref: string; title: string; body: string; created_at: number }>()
  const rowIds: number[] = []
  for (const [id] of [...merged.entries()].sort((a, b) => b[1] - a[1])) {
    const c = getChunk.get(id) as { id: number; ref: string; title: string; body: string; created_at: number } | undefined
    if (!c) continue
    if (source && !source.some((s) => c.ref.startsWith(s))) continue
    chunkMap.set(id, c)
    rowIds.push(id)
    if (rowIds.length >= 200) break
  }
  if (opts.sort === 'timeline') rowIds.sort((a, b) => (chunkMap.get(b)?.created_at ?? 0) - (chunkMap.get(a)?.created_at ?? 0))
  else rowIds.sort((a, b) => (merged.get(b) ?? 0) - (merged.get(a) ?? 0))
  const hits: SearchHit[] = []
  let bytes = 0
  for (const id of rowIds.slice(0, opts.topN)) {
    const c = chunkMap.get(id)!
    const snippet = `${c.title} — ${getSnippet(c.body, terms)}`
    if (bytes + snippet.length > opts.budgetBytes) break
    bytes += snippet.length
    hits.push({ id: c.id, ref: c.ref, title: c.title, snippet, score: opts.sort === 'timeline' ? c.created_at : (merged.get(id) ?? 0) })
  }
  return hits
}

/** FTS5 冒烟：三种查询都命中才算 schema + tokenizer 正常（用于任意带 schema 的 db，含 :memory:）。 */
export function smokeFts5(db: DatabaseSync): { porter: boolean; trigram: boolean; weight: boolean } {
  const doc = 'running code in the sandbox saves context tokens'
  addChunk(db, 'smoke', 'smoke title', doc, 86_400_000)
  const porter = (db.prepare(`SELECT count(*) AS n FROM chunks_porter WHERE chunks_porter MATCH 'sandbox'`).get() as { n: number }).n > 0
  const trigram = (db.prepare(`SELECT count(*) AS n FROM chunks_trigram WHERE chunks_trigram MATCH 'sandbox'`).get() as { n: number }).n > 0
  const weighted = db.prepare(`SELECT c.ref FROM chunks_porter JOIN chunks c ON c.id = chunks_porter.rowid WHERE chunks_porter MATCH 'sandbox' ORDER BY bm25(chunks_porter, 5.0, 1.0) LIMIT 1`).get() as { ref: string } | undefined
  purgeChunks(db)
  return { porter, trigram, weight: weighted !== undefined }
}

export { RRF_K }
