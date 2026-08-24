// knowledge/sqlite.ts — 知识库后端：node:sqlite + FTS5 外部内容双表 + 存储层
// 标题 5x 用 bm25(t, 5.0, 1.0) 列权重；RRF 合并；TTL 惰性失效。
// FTS 外部内容表与 chunks 表通过 rowid 同步（实测通过），删除用 'delete'，清库用 'rebuild'。
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { byteLen } from '../util/bytes.ts'

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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) // R5-4（S-M3）：目录权限收紧
  const file = path.join(dir, 'content.db')
  const db = new DatabaseSync(file)
  // R3-1（B-08e）：并发写防护——WAL + busy_timeout（多进程共享 content.db 时防 database is locked）
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  createSchema(db)
  return { db, file }
}

/** 写入一个 chunk（chunks + 两个 FTS 表同步）。R4-3（B-02）：三表写入包事务，中途失败回滚不留孤儿 chunk。 */
export function addChunk(db: DatabaseSync, ref: string, title: string, body: string, ttlMs: number, now = Date.now()) {
  db.exec('BEGIN')
  try {
    const id = Number(db.prepare('INSERT INTO chunks(ref,title,body,created_at,ttl_ms) VALUES(?,?,?,?,?)').run(ref, title, body, now, ttlMs).lastInsertRowid)
    db.prepare('INSERT INTO chunks_porter(rowid,title,body) VALUES(?,?,?)').run(id, title, body)
    db.prepare('INSERT INTO chunks_trigram(rowid,title,body) VALUES(?,?,?)').run(id, title, body)
    db.exec('COMMIT')
    return id
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
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

/** R4-7（B-08d）：覆盖写 meta（非累加）。 */
export function setMeta(db: DatabaseSync, key: string, value: number) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}

/** R4-7（B-08d）：当前在库 chunk 的真实字节总量（与 chunkStats 同口径；覆盖写 indexed_bytes 用）。 */
export function currentIndexedBytes(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM chunks').get() as { bytes: number }
  return row.bytes
}

/** P4：知识库分片统计（ctx_doctor 用）。expired 为惰性未清量（下次 deleteExpired 才删）。 */
export function chunkStats(db: DatabaseSync, now = Date.now()): { total: number; live: number; expired: number; bytes: number } {
  const row = db.prepare('SELECT count(*) AS total, COALESCE(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM chunks').get() as { total: number; bytes: number }
  const expiredRow = db.prepare('SELECT count(*) AS n FROM chunks WHERE created_at + ttl_ms <= ?').get(now) as { n: number }
  return { total: row.total, live: row.total - expiredRow.n, expired: expiredRow.n, bytes: row.bytes }
}

/** 修正口径的节约台账（S7）：measured_saved 仅 read 侧检测口径（read_denied_bytes，唯一精确「本应进入上下文」）；
 *  entered = search_bytes + execute_log_bytes（实际进入/返还）；kept_out_pct_measured 只反映 read 侧，不代表全量节约。
 *  kept_out_pct_total 含 estimate/下界（indexed-search 粗差 + denied_bytes 命令串下界），与之并列展示。
 *  P0-1 度量闭环：新增 redirect（洪水被改道 -> redirect_bytes，下界=命令串长度）、retrieval（ctx_search 命中片段 -> retrieval_bytes，真实进入上下文）、
 *  rejected（deny 回传 rejected-approach -> rejected_bytes，reason 文本下界），让 kept_out_pct 更接近官方「逆向记账」的 measured 口径。 */
export function computeSavedBytes(db: DatabaseSync): {
  indexed: number
  search: number
  readDenied: number
  cmdDenied: number
  redirect: number
  retrieval: number
  rejected: number
  executeLog: number
  saved: number
  savedMeasured: number
  savedEstimate: number
  measuredSaved: number
  entered: number
  keptOutMeasured: number
  keptOutTotal: number
} {
  const indexed = getMeta(db, 'indexed_bytes')
  const search = getMeta(db, 'search_bytes')
  const readDenied = getMeta(db, 'read_denied_bytes')
  const cmdDenied = getMeta(db, 'denied_bytes')
  const redirect = getMeta(db, 'redirect_bytes')
  const retrieval = getMeta(db, 'retrieval_bytes')
  const rejected = getMeta(db, 'rejected_bytes')
  const executeLog = getMeta(db, 'execute_log_bytes')
  // R5-1（D-H3）：口径收敛——savedMeasured 仅可证伪项（read 精确 + 命令串/改道下界）；savedEstimate 为粗差（indexed−search）与 rejected 下界，明确标注不入 measured。
  const savedMeasured = readDenied + cmdDenied + redirect
  const savedEstimate = Math.max(0, indexed - search) + rejected
  const saved = savedMeasured + savedEstimate // 兼容字段（ctx_stats 默认只展示 measured）
  const measuredSaved = savedMeasured
  const entered = search + executeLog
  const keptOutMeasured = savedMeasured + entered > 0 ? (savedMeasured / (savedMeasured + entered)) * 100 : 0
  const keptOutTotal = saved + entered > 0 ? (saved / (saved + entered)) * 100 : 0
  return { indexed, search, readDenied, cmdDenied, redirect, retrieval, rejected, executeLog, saved, savedMeasured, savedEstimate, measuredSaved, entered, keptOutMeasured, keptOutTotal }
}

/** 取体文本（M1 命中片段用）。 */
function getSnippet(body: string, terms: string[], window = 64): string {  const lower = body.toLowerCase()
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
    const tryQuery = (q: string) => {
      const rows = db.prepare(
        `SELECT ${table}.rowid AS id, bm25(${table}, 5.0, 1.0) AS s
         FROM ${table} JOIN chunks c ON c.id = ${table}.rowid
         WHERE ${table} MATCH ? AND c.created_at + c.ttl_ms > ?
         ORDER BY s LIMIT 200`,
      ).all(q, now) as { id: number }[]
      rows.forEach((r, i) => m.set(r.id, i))
    }
    try {
      tryQuery(opts.query)
    } catch {
      // R3-2（B-08g）：原 query 触发 FTS5 语法错误 → 逐词加引号转义重试，避免整表静默退出 RRF
      try {
        const escaped = opts.query.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(' ')
        if (escaped) tryQuery(escaped)
      } catch { /* 仍失败：该表不参与 RRF（静默降级） */ }
    }
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
    const bl = byteLen(snippet)
    if (bl > opts.budgetBytes) continue // R4-5（B-04）：单条超预算跳过，避免首条超限断出空结果
    if (bytes + bl > opts.budgetBytes) break
    bytes += bl
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
