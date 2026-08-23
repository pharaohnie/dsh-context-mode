// knowledge/tools.ts — 知识库四个模型工具（ctx_index / ctx_search / ctx_fetch_and_index / ctx_purge）
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import { addChunk, deleteByRef, deleteExpired, incMeta, openKnowledgeDb, purgeChunks, searchChunks, type KnowledgeDb } from './sqlite.ts'
import { chunkMarkdown } from './chunker.ts'
import { concurrencyPool, urlToMarkdown } from './web.ts'

/** ctx_search 默认输出字节预算（也与 advice/deny reason 中引用的「预算」对齐）。 */
export const SEARCH_BUDGET_BYTES = 8000

export interface KnowledgeToolsDeps {
  kdb: KnowledgeDb | null
  config: { knowledgeBaseTtlMs: number; knowledgeBaseConcurrency: number }
}

function collectFiles(paths: string[], maxFiles = 2000): string[] {
  const out: string[] = []
  const walk = (p: string) => {
    if (out.length >= maxFiles) return
    let st
    try { st = fs.statSync(p) } catch { return }
    if (st.isFile()) { out.push(p); return }
    if (st.isDirectory()) {
      let entries: string[] = []
      try { entries = fs.readdirSync(p) } catch { return }
      for (const e of entries) walk(path.join(p, e))
    }
  }
  for (const p of paths) walk(p)
  return out
}

const textSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    count: { type: 'number', required: true },
  },
}

export function registerKnowledgeTools(ctx: { tools: { register(def: unknown): unknown } }, deps: KnowledgeToolsDeps) {
  const { kdb, config } = deps
  const requireDb = () => {
    if (!kdb) throw new Error('context-mode 知识库未就绪（目录不可写？）')
    return kdb.db
  }

  ctx.tools.register(defineTool({
    name: 'ctx_index',
    description: '把本地文件或目录索引为知识库。按标题切分、保留代码块，写入 FTS5 双表（porter 词根 + trigram 子串）。结果供 ctx_search 检索。',
    parameters: {
      paths: { type: 'array', required: true, items: { type: 'string' }, description: '文件或目录路径，递归收集' },
      ttlMs: { type: 'number', description: '覆盖默认 TTL（毫秒）' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { paths: string[]; ttlMs?: number }) {
      const d = requireDb()
      const files = collectFiles(args.paths)
      const ttl = args.ttlMs ?? config.knowledgeBaseTtlMs
      let chunks = 0
      let bytes = 0
      for (const f of files) {
        try {
          deleteByRef(d, f) // replace-on-index：重索引前先删该 ref 旧 chunks，避免 db 随重复索引增长
          for (const p of chunkMarkdown(fs.readFileSync(f, 'utf8'))) { addChunk(d, f, p.title, p.body, ttl); chunks++; bytes += p.body.length }
        } catch { /* 单个文件读取失败跳过 */ }
      }
      if (bytes > 0) incMeta(d, 'indexed_bytes', bytes)
      return { text: `已索引 ${files.length} 个文件、${chunks} 个 chunk（${bytes} 字节）。`, count: chunks }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_search',
    description: '在知识库里检索：porter 词根 + trigram 子串双策略 BM25，RRF 合并，返回命中片段（词前后窗口）。支持 queries[] 批量、sort(timeline/relevance)、source(ref 前缀过滤)。大输出先走索引再检索，省上下文。',
    parameters: {
      query: { type: 'string', description: '检索词（给单一 query 时用；与 queries 同时给则以 queries 为准）' },
      queries: { type: 'array', items: { type: 'string' }, description: '批量检索词，一次往返' },
      sort: { type: 'string', enum: ['relevance', 'timeline'], description: '默认 relevance（RRF score）；timeline 按入库时间（最新在前）' },
      source: { type: 'array', items: { type: 'string' }, description: '按 ref 前缀过滤（如 memory:decision；单 string 视为单元素；源前缀 OR）' },
      topN: { type: 'number', description: '返回条数上限（默认 10）' },
      budgetBytes: { type: 'number', description: '输出字节预算（默认 8000）' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { query?: string; queries?: string[]; sort?: 'relevance' | 'timeline'; source?: string | string[]; topN?: number; budgetBytes?: number }) {
      const d = requireDb()
      deleteExpired(d)
      const sort = args.sort ?? 'relevance'
      const source = args.source ? (Array.isArray(args.source) ? args.source : [args.source]) : undefined
      const queries = args.queries && args.queries.length ? args.queries : (args.query ? [args.query] : [])
      if (!queries.length) return { text: '（无查询词）', count: 0 }
      const budget = args.budgetBytes ?? SEARCH_BUDGET_BYTES
      const topN = args.topN ?? 10
      // 多 query：各自 searchChunks（大 topN/budget 以免过早裁切），合并去重后按 sort 排序，再裁 budget + topN
      const hitsArr: { id: number; ref: string; title: string; snippet: string; score: number }[] = []
      const seen = new Set<number>()
      for (const q of queries) {
        for (const h of searchChunks(d, { query: q, topN: topN * 3, budgetBytes: Math.max(budget * 3, 2000), sort, source })) {
          if (!seen.has(h.id)) { seen.add(h.id); hitsArr.push(h) }
        }
      }
      hitsArr.sort((a, b) => b.score - a.score)
      let bytes = 0
      const clipped: typeof hitsArr = []
      for (const h of hitsArr) {
        if (bytes + h.snippet.length > budget) break
        bytes += h.snippet.length
        clipped.push(h)
        if (clipped.length >= topN) break
      }
      const lines = clipped.map((h) => `[score ${h.score.toFixed(3)}] ${h.snippet}\n  ref: ${h.ref}`)
      const returnedBytes = clipped.reduce((a, h) => a + h.snippet.length, 0)
      if (returnedBytes > 0) incMeta(d, 'search_bytes', returnedBytes)
      return { text: lines.length ? lines.join('\n') : '（无命中）', count: clipped.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_fetch_and_index',
    description: '抓取一个或多个 URL，转 markdown、切片、入库（TTL 默认 24h、可覆盖）。',
    parameters: {
      urls: { type: 'array', required: true, items: { type: 'string' }, description: 'URL 列表' },
      ttlMs: { type: 'number', description: '覆盖默认 TTL' },
      concurrency: { type: 'number', description: '并发 1-8（默认按 config）' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { urls: string[]; ttlMs?: number; concurrency?: number }) {
      const d = requireDb()
      const ttl = args.ttlMs ?? config.knowledgeBaseTtlMs
      const concurrency = args.concurrency ?? config.knowledgeBaseConcurrency
      let chunks = 0
      let bytes = 0
      const errors: string[] = []
      await concurrencyPool(args.urls, concurrency, async (url) => {
        try {
          deleteByRef(d, url) // replace-on-index：重抓先删该 URL 旧 chunks
          const { title, markdown } = await urlToMarkdown(url)
          const parts = chunkMarkdown(markdown)
          const labeled = parts.length ? parts : [{ title, body: markdown }]
          for (const p of labeled) { addChunk(d, url, p.title, p.body, ttl); chunks++; bytes += p.body.length }
        } catch (e) { errors.push(`${url}: ${(e as Error).message}`) }
      })
      if (bytes > 0) incMeta(d, 'indexed_bytes', bytes)
      return {
        text: `已抓取 ${args.urls.length} 个 URL、入库 ${chunks} 个 chunk（${bytes} 字节）${errors.length ? `，${errors.length} 个失败：${errors.join('; ')}` : '。'}`,
        count: chunks,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_purge',
    description: '清空知识库所有 chunk（含 FTS 索引同步）。',
    parameters: {},
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute() {
      const d = requireDb()
      const n = purgeChunks(d)
      return { text: `已清空 ${n} 个 chunk。`, count: n }
    },
  }))
}
