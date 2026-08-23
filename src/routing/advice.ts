// routing/advice.ts — systemPrompt.section(order=140) 指引注入（避开 run_code SDK 的 150；位于 read 工具 tool:read order:100 与 run_code 150 之间，层序无冲突）
// P2a：结构化 routing block（工具选择层级 + ctx_execute vs run_code 关系 + 禁令/when_not_to_use/平台名），text 用函数烘焙常量。
// 形状：PromptSection={name,order,text:string|fn,complete?}；无 priority/role；结构编码在 text（markdown/标签式）。（S4：落地用 cordis_inspect 二次戳实）
// 护栏：只约束数据去向，不约束文风（不强制 prose 风格）。advice 文本每步常驻，有 token 成本；可用 adviceRich=false 回退精简散文。
export interface AdviceDeps {
  enabled: boolean
  maxReadBytesBeforeAsk: number
  budgetBytes: number
  trustedReadBasenames: string[]
  adviceStructured: boolean
  adviceRich: boolean
  executeDefaultLanguage: string
}

function buildStructured(deps: AdviceDeps): () => string {
  const threshold = deps.maxReadBytesBeforeAsk
  const thresholdTokens = Math.round(threshold / 4)
  const budget = deps.budgetBytes
  const trusted = deps.trustedReadBasenames.join('/')
  const lang = deps.executeDefaultLanguage
  return () => `# context-mode routing (MANDATORY)
## Think in Code — MANDATORY
分析/统计/过滤/比较/搜索/解析/转换数据 → 用 ctx_execute(language:"${lang}", code) 写程序并只 console.log 答案；原始数据留在沙箱。不要直接把原始数据读进上下文。PROGRAM the analysis, not COMPUTE it.
## Tool hierarchy: 0 MEMORY → 1 GATHER → 2 PROCESSING
- 0 MEMORY: ctx_search / ctx_stats            (检索已知/看节约)
- 1 GATHER:  ctx_index / ctx_fetch_and_index / ctx_execute_file (入知识库/沙箱；file = DATA)
- 2 PROCESSING: ctx_execute / ctx_batch_execute (在 codeRuntime 里算，只回答案)
- 3 PROCESSING: run_code (DSH 原生；仅当需原生 sub-dispatch 形态才用)
## ctx_execute vs run_code (B4)
ctx_execute = context-mode 受引导的 codeRuntime 封装（带记账/批量/记忆/改道引导）；run_code = DSH 原生沙箱工具。底层同一 codeRuntime。优先 ctx_execute（受路由/记账）。
## Do NOT attempt (host-denied)
- curl / wget / inline-fetch → 用 ctx_fetch_and_index
- read > ${threshold} 字节(≈${thresholdTokens} tokens) whole → denied; 用 ctx_index+ctx_search, 或 read 带 offset/limit
## when_not_to_use
- ctx_search: 已有确切内容时；定向 read offset/limit 更省时
- ctx_execute: 纯抓取/下载用 ctx_fetch_and_index；需 shell 且无审批时
## File writing policy
- 写文件用原生 Write/Edit；ctx_execute 是资源隔离（空环境/heap cap/硬中断）非数据沙箱，信任姿态与 bash 同级，**不承诺**程序无法读/写宿主文件 (B1)。
## Memory continuity
- On resume: ctx_search(sort:"timeline", source:["memory:decision","memory:constraint","memory:user-prompt","memory:rejected-approach"]) 再向用户提问。
## 检索预算
- ctx_search 默认 budget ${budget} 字节，只回命中片段；先索引再检索，重复索引重复计入。
## 信任文档
- ${trusted} 可全量读，无需先索引（仍设上限防极端大文档）。`
}

function buildLean(deps: AdviceDeps): () => string {
  const threshold = deps.maxReadBytesBeforeAsk
  return () => `Context-mode guidance:
- 大文件 > ${threshold} 字节：先 ctx_index/ctx_fetch_and_index 索引，再 ctx_search 取片段；确需分段用带 offset/limit 的精确读。
- 计算/分析用 ctx_execute(language:"ts", code)（只 console.log 答案）；批量用 ctx_batch_execute。
- 抓网页用 ctx_fetch_and_index（不要 curl/wget）。`
}

export function registerAdvice(ctx: { systemPrompt: { section(s: unknown): unknown } }, deps: AdviceDeps) {
  if (!deps.enabled) return
  const text = deps.adviceRich
    ? (deps.adviceStructured ? buildStructured(deps) : buildLean(deps))
    : buildLean(deps)
  ctx.systemPrompt.section({
    name: 'context-mode',
    order: 140,
    text,
  })
}
