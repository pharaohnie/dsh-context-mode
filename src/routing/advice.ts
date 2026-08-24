// routing/advice.ts — systemPrompt.section(order=30) 触发式指引注入
// 参照上游 context-mode（SKILL + routing-block）的「触发式」做法：MANDATORY 默认规则 + 白名单 + 决策树 + 触发短语，
// 替代早期「抽象层级 0/1/2/3 + 禁令」。order=30（紧跟 persona/identity 后、任务上下文前），提高「何时用」的关注度。
// 形状：PromptSection={name,order,text:string|fn,complete?}；无 priority/role；结构编码在 text。
// 护栏：只约束数据去向，不约束文风。adviceRich=false 回退精简散文（advice.txt）。
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

## 默认规则（MANDATORY：先 context-mode，仅白名单用原生工具）
默认：读大文件 / 跑命令拿输出 / 抓网页 / 分析汇总 → **先用 ctx_*（ctx_execute / ctx_execute_file / ctx_batch_execute / ctx_fetch_and_index + ctx_search）**。
只在以下**白名单**场景用原生工具：
- 文件写/状态变更：Write / Edit / git add|commit|push / mkdir / mv / cp / rm / cd / pwd / kill / npm install / echo
- 确定的小输出观察：pwd / 干净 git status / whoami
- 编辑文件：Read（Edit 需要精确字节在上下文）
**其它一切 → ctx_execute / ctx_execute_file。** 不确定时用 context-mode——每 KB 不必要上下文都降低整段会话质量与速度。

## 决策树（意图 → 工具）
- 读文件做分析/摘要/抽取 → ctx_execute_file(path, code)（FILE_SRC 引用内容，只回答案）
- 跑命令 / 调 API、要处理输出 → ctx_execute(language:"js"|"${lang}", code)
- 并行多命令 + 同轮检索 → ctx_batch_execute(commands, queries)
- 抓网页 / 外部文档 → ctx_fetch_and_index(urls) → ctx_search(queries)
- 只需看短固定输出（git status 干净 / pwd / whoami）→ Bash
- 编辑文件 → Read + Edit/Write
- 数据已在上下文 → 直接用，不要 ctx_index(content:...) 重复索引

## 触发短语（遇到即用 ctx_*，不用问）
analyze logs · summarize output · process data · parse JSON · filter results · check build output · run tests · git log / diff · list containers · disk usage · fetch docs · API reference · index documentation · call API · count lines · codebase statistics · dependency audit · 任何可能超 ~20 行的工具输出

## Do NOT attempt (host-denied)
- curl / wget / inline-fetch → 用 ctx_fetch_and_index
- read > ${threshold} 字节(≈${thresholdTokens} tokens) whole → denied；用 ctx_index+ctx_search，或 read 带 offset/limit
- ctx_* 的 shell 路由默认关闭 → 用 js/ts，或 ctx_fetch_and_index

## ctx_execute vs run_code
ctx_execute = context-mode 受引导的 codeRuntime 封装（带记账/批量/记忆/改道）；run_code = DSH 原生沙箱。底层同 codeRuntime；优先 ctx_execute（受路由/记账）。

## when_not_to_use
- ctx_search：已有确切内容时；定向 read offset/limit 更省时
- ctx_execute：纯抓取/下载用 ctx_fetch_and_index；需 shell 且无审批时

## File writing policy
写文件用原生 Write/Edit；ctx_execute 是资源隔离（空环境/heap cap/硬中断）非数据沙箱，信任姿态与 bash 同级，**不承诺**程序无法读/写宿主文件。

## Memory continuity
On resume: ctx_search(sort:"timeline", source:["memory:decision","memory:constraint","memory:user-prompt","memory:rejected-approach"]) 再向用户提问。

## 检索预算
ctx_search 默认 budget ${budget} 字节，只回命中片段；先索引再检索，重复索引重复计入。

## 信任文档
${trusted} 可全量读，无需先索引（仍设上限防极端大文档）。`
}

function buildLean(deps: AdviceDeps): () => string {
  const threshold = deps.maxReadBytesBeforeAsk
  return () => `Context-mode (MANDATORY): 默认读大文件/跑命令拿输出/抓网页/分析 → 用 ctx_execute / ctx_execute_file / ctx_batch_execute / ctx_fetch_and_index + ctx_search。仅文件写(git/mkdir/cp/rm)、小输出观察(pwd/whoami)、编辑(Read/Edit)才用原生工具。
- 读文件做分析 → ctx_execute_file；跑命令/调 API 要处理 → ctx_execute；并行+检索 → ctx_batch_execute；抓网页 → ctx_fetch_and_index。
- 大文件 > ${threshold} 字节：先 ctx_index 再 ctx_search 取片段；确需分段用带 offset/limit 的精确读。
- 计算/分析用 ctx_execute(language:"ts", code)，只 console.log 答案；批量用 ctx_batch_execute。
- 抓网页用 ctx_fetch_and_index（不要 curl/wget）。`
}

export function registerAdvice(ctx: { systemPrompt: { section(s: unknown): unknown } }, deps: AdviceDeps) {
  if (!deps.enabled) return
  const text = deps.adviceRich
    ? (deps.adviceStructured ? buildStructured(deps) : buildLean(deps))
    : buildLean(deps)
  ctx.systemPrompt.section({
    name: 'context-mode',
    order: 30,
    text,
  })
}
