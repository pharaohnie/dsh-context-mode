// knowledge/tools.ts — 知识库四个模型工具（ctx_index / ctx_search / ctx_fetch_and_index / ctx_purge）
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import { addChunk, deleteByRef, deleteExpired, incMeta, setMeta, currentIndexedBytes, openKnowledgeDb, purgeChunks, searchChunks, type KnowledgeDb } from './sqlite.ts'
import { chunkMarkdown } from './chunker.ts'
import { concurrencyPool, urlToMarkdown } from './web.ts'
import { type FloodGuard, createFloodGuard } from './flood-guard.ts'
import { byteLen } from '../util/bytes.ts'

/** ctx_search 默认输出字节预算（也与 advice/deny reason 中引用的「预算」对齐）。 */
// P3-2：SEO 检索粒度常量。定位为内部常量（与 chunker maxBytes 一致，非部署差异点）——文案/召回粒度跟随知识库单元，
// 不随部署不同而变，故不做成 config；如需调可用 ctx_search(budgetBytes:) 覆盖单次。 
export const SEARCH_BUDGET_BYTES = 12000

export interface KnowledgeToolsDeps {
  kdb: KnowledgeDb | null
  config: { knowledgeBaseTtlMs: number; knowledgeBaseConcurrency: number; searchWindowMs?: number; searchMaxResultsAfter?: number; searchBlockAfter?: number; maxSourceBytes?: number }
  /** P1：搜索 FloodGuard（per-agent-context 分桶）。由 index.ts 创建单例并共享给 ctx_doctor；缺省回退自建（行为等价）。 */
  floodGuard?: FloodGuard
}

export function collectFiles(paths: string[], maxFiles = 2000, maxDepth = 32): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (p: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return
    let real: string
    try { real = fs.realpathSync(p) } catch { return } // 不存在/无权限 → 跳过
    if (seen.has(real)) return // 环/重复防护（R1-4/B-08）
    seen.add(real)
    let st
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) return // 不跟随 symlink：防环 + 防越界遍历（R1-4/B-08）
    if (st.isFile()) { out.push(p); return }
    if (st.isDirectory()) {
      const dirName = path.basename(p)
      if (dirName === '.git' || dirName === 'node_modules' || dirName === '.pnpm-store') return // 跳过二进制/隐藏目录（修复 .git 二进制扫描问题）
      let entries: string[] = []
      try { entries = fs.readdirSync(p) } catch { return }
      for (const e of entries) walk(path.join(p, e), depth + 1)
    }
  }
  for (const p of paths) walk(p, 0)
  return out
}

const textSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    count: { type: 'number', required: true },
  },
} as const

export function registerKnowledgeTools(ctx: { tools: { register(def: unknown): unknown }; get(name: string): unknown }, deps: KnowledgeToolsDeps) {
  const { kdb, config } = deps
  // P1：搜索 FloodGuard（per-agent-context 分桶时间窗滚动计数；优先用 index.ts 传入的单例，供 doctor 观测）
  const floodHit = deps.floodGuard ?? createFloodGuard(config.searchWindowMs ?? 60_000, config.searchMaxResultsAfter ?? 3, config.searchBlockAfter ?? 8)
  const requireDb = () => {
    if (!kdb) throw new Error('context-mode 知识库未就绪（目录不可写？）')
    return kdb.db
  }
  // R1-1（S-H1）：文件内容读取只走 ctx.fs（受宿主审批/沙箱/文件治理）；ctx.fs 缺失或 resolve 失败 → 抛错，绝不回退 node:fs 旁路。
  const readFileContents = async (path: string, exec: any): Promise<string> => {
    const ctxFs = ctx.get('fs') as { resolve?: (p: string, o?: any) => Promise<any>; readText?: (t: any, s?: any) => Promise<string> } | undefined
    if (ctxFs && typeof ctxFs.resolve === 'function' && typeof ctxFs.readText === 'function') {
      const target = await ctxFs.resolve(path)
      if (target != null) {
        const src = await ctxFs.readText(target, exec?.signal)
        // R3-3（D-H2/B-06）：单文件内容上限（对称于 read 门禁；防整读大文件进内存/worker 重编译）
        if (byteLen(src) > (config.maxSourceBytes ?? 2_000_000)) {
          throw new Error(`context-mode: 文件 ${path} 超过 ${config.maxSourceBytes ?? 2_000_000} 字节上限（B-06），请用 ctx_index 分片或 ctx_search。`)
        }
        return src
      }
      throw new Error(`context-mode: 路径 ${path} 无法经宿主 fs 解析（resolve 返回 null），已拒绝（不再回退 node:fs）。`)
    }
    throw new Error('context-mode: 宿主 fs 服务未挂载，ctx_index 拒绝读取（避免绕过文件治理）。请检查 ctx_doctor 的 fs 报告。')
  }

  ctx.tools.register(defineTool({
    name: 'ctx_index',
    description: '索引到知识库：把本地文件或目录切片（按标题、保留代码块），写入 FTS5 双表（porter 词根 + trigram 子串）。何时用：需要处理/复用大文件或目录内容、供后续检索时（先 index 再 ctx_search）。同一目录/多个文件要用时，ctx_index(目录) 一次入库，比逐个 read 省——代替一次性整读。',
    parameters: {
      paths: { type: 'array', required: true, items: { type: 'string' }, description: '文件或目录路径，递归收集' },
      ttlMs: { type: 'number', description: '覆盖默认 TTL（毫秒）' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { paths: string[]; ttlMs?: number }, exec: any) {
      const d = requireDb()
      deleteExpired(d) // R4-4（B-03）：入库前清理过期 chunk
      const files = collectFiles(args.paths)
      const ttl = args.ttlMs ?? config.knowledgeBaseTtlMs
      let chunks = 0
      let bytes = 0
      for (const f of files) {
        try {
          deleteByRef(d, f) // replace-on-index：重索引前先删该 ref 旧 chunks，避免 db 随重复索引增长
          const src = await readFileContents(f, exec) // P1②：读文件内容只走 ctx.fs（R1-1：无 node:fs 回退，避免绕过宿主文件治理）
          for (const p of chunkMarkdown(src)) { addChunk(d, f, p.title, p.body, ttl); chunks++; bytes += byteLen(p.body) }
        } catch (e) { console.warn('[context-mode] ctx_index 读取失败:', (e as Error).message) } // R5-2（B-08f）：失败留痕
      }
      if (bytes > 0) setMeta(d, 'indexed_bytes', currentIndexedBytes(d)) // R4-7（B-08d）：覆盖为当前在库字节，不再累加虚增
      return { text: `已索引 ${files.length} 个文件、${chunks} 个 chunk（${bytes} 字节）。`, count: chunks }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_search',
    description: '在知识库里检索：porter 词根 + trigram 子串双策略 BM25，RRF 合并，返回命中片段（词前后窗口）。何时用：从已索引内容取所需片段时；把相关问题一次问清（queries 批量）。不要重复检索已在上下文里的内容。',
    parameters: {
      query: { type: 'string', description: '检索词（给单一 query 时用；与 queries 同时给则以 queries 为准）' },
      queries: { type: 'array', items: { type: 'string' }, description: '批量检索词，一次往返' },
      sort: { type: 'string', enum: ['relevance', 'timeline'], description: '默认 relevance（RRF score）；timeline 按入库时间（最新在前）' },
      source: { type: 'array', items: { type: 'string' }, description: '按 ref 前缀过滤（如 memory:decision；单 string 视为单元素；源前缀 OR）' },
      topN: { type: 'number', description: '返回条数上限（默认 16）' },
      budgetBytes: { type: 'number', description: `输出字节预算（默认 ${SEARCH_BUDGET_BYTES}）` },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { query?: string; queries?: string[]; sort?: 'relevance' | 'timeline'; source?: string[]; topN?: number; budgetBytes?: number }, exec: any) {
      const d = requireDb()
      deleteExpired(d)
      // P1：搜索 FloodGuard（per-agent-context 分桶）。key = agent.sessionId → 各子代理独立预算，并行 fan-out 不互相误伤（对齐官方 #769）。
      // exec 可能缺失（如测试直调）→ key='default'（单桶回退，行为同旧实现）。
      const gate = floodHit.record(exec?.agent?.sessionId)
      if (gate === 'block') {
        throw new Error('context-mode: 检索调用过于频繁（超过时间窗硬上限），已节流。请减少检索频率，或改用 ctx_execute_file/ctx_batch_execute 定向取数。')
      }
      const sort = args.sort ?? 'relevance'
      const source = args.source ? (Array.isArray(args.source) ? args.source : [args.source]) : undefined
      const queries = args.queries && args.queries.length ? args.queries : (args.query ? [args.query] : [])
      if (!queries.length) return { text: '（无查询词）', count: 0 }
      const budget = args.budgetBytes ?? SEARCH_BUDGET_BYTES
      // taper 时收缩 topN（软上限，不做硬 block，只是降低返回体量避免窗口被检索反复撑大）
      let topN = args.topN ?? 16
      if (gate === 'taper') topN = Math.max(1, Math.floor(topN / 2))
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
        const bl = byteLen(h.snippet)
        if (bl > budget) continue // R4-5（B-04）：单条超预算跳过，避免首条超限断出空结果
        if (bytes + bl > budget) break
        bytes += bl
        clipped.push(h)
        if (clipped.length >= topN) break
      }
      const lines = clipped.map((h) => `[score ${h.score.toFixed(3)}] ${h.snippet}\n  ref: ${h.ref}`)
      const returnedBytes = clipped.reduce((a, h) => a + byteLen(h.snippet), 0)
      if (returnedBytes > 0) {
        incMeta(d, 'search_bytes', returnedBytes) // R5-1（D-H3）：retrieval_bytes 与 search_bytes 同值冗余，已移除该记账
      }
      return { text: lines.length ? lines.join('\n') : '（无命中）', count: clipped.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_fetch_and_index',
    description: '抓取一个或多个 URL，转 markdown、切片、入库（TTL 默认 24h、可覆盖）。何时用：抓网页/外部文档并入库检索，原始页面字节不进上下文；代替 curl/wget/WebFetch 直读。抓后 ctx_search。',
    parameters: {
      urls: { type: 'array', required: true, items: { type: 'string' }, description: 'URL 列表' },
      ttlMs: { type: 'number', description: '覆盖默认 TTL' },
      concurrency: { type: 'number', description: '并发 1-8（默认按 config）' },
    },
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute(args: { urls: string[]; ttlMs?: number; concurrency?: number }, exec: any) {
      const d = requireDb()
      deleteExpired(d) // R4-4（B-03）：入库前清理过期 chunk
      const ttl = args.ttlMs ?? config.knowledgeBaseTtlMs
      const concurrency = args.concurrency ?? config.knowledgeBaseConcurrency
      let chunks = 0
      let bytes = 0
      const errors: string[] = []
      await concurrencyPool(args.urls, concurrency, async (url) => {
        try {
          deleteByRef(d, url) // replace-on-index：重抓先删该 URL 旧 chunks
          const { title, markdown } = await urlToMarkdown(url, { signal: exec?.signal })
          const parts = chunkMarkdown(markdown)
          const labeled = parts.length ? parts : [{ title, body: markdown }]
          for (const p of labeled) { addChunk(d, url, p.title, p.body, ttl); chunks++; bytes += byteLen(p.body) }
        } catch (e) { errors.push(`${url}: ${(e as Error).message}`) }
      })
      if (bytes > 0) setMeta(d, 'indexed_bytes', currentIndexedBytes(d)) // R4-7（B-08d）：覆盖为当前在库字节
      return {
        text: `已抓取 ${args.urls.length} 个 URL、入库 ${chunks} 个 chunk（${bytes} 字节）${errors.length ? `，${errors.length} 个失败：${errors.join('; ')}` : '。'}`,
        count: chunks,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctx_purge',
    description: '永久清空知识库所有 chunk（含 FTS 索引同步）。不可逆；仅在要彻底重置知识库时用。',
    parameters: {},
    output: { schema: textSchema, render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any },
    async execute() {
      const d = requireDb()
      const n = purgeChunks(d)
      return { text: `已清空 ${n} 个 chunk。`, count: n }
    },
  }))
}
