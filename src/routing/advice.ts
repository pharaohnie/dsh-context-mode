// routing/advice.ts — systemPrompt.section(order=30) 触发式指引注入
// 参照上游 context-mode（SKILL + routing-block）的「触发式」做法。
// v2：把「一刀切推 ctx_*」改为「按用途+大小分界」（懂语义→read；大/整目录/统计→ctx_*），
//     并加「自我调控」信号（本会话读了很多/连读同目录→改 ctx_index(目录)+ctx_search）。
// 依据：DSH tools/pre-execute 无法做非阻塞软引导（next() 不回流提示、contextNote 只在 deny 送达），
//       故 runtime 累计/目录信号并入本指引文本，由模型自判（M1/M2/M3）。
// order=30（紧跟 persona/identity 后、任务上下文前），提高「何时用」的关注度。
export interface AdviceDeps {
  enabled: boolean
  maxReadBytesBeforeAsk: number
  budgetBytes: number
  trustedReadBasenames: string[]
  adviceStructured: boolean
  adviceRich: boolean
  executeDefaultLanguage: string
}

export function buildStructured(deps: AdviceDeps): () => string {
  const threshold = deps.maxReadBytesBeforeAsk
  const thresholdTokens = Math.round(threshold / 4)
  const budget = deps.budgetBytes
  const trusted = deps.trustedReadBasenames.join('/')
  const lang = deps.executeDefaultLanguage
  return () => `# context-mode routing (MANDATORY)
## Think in Code — MANDATORY
分析/统计/过滤/比较/搜索/解析/转换数据 → 用 ctx_execute(language:"${lang}", code) 写程序并只 console.log 答案；原始数据留在沙箱。不要直接把原始数据读进上下文。PROGRAM the analysis, not COMPUTE it.

## 判定准则（该 read 还是该用 ctx_*？）
- **看懂少量小文件**（单个 ≤ ${threshold} 字节、且你要理解其语义/精确内容，如读几行配置、看一个源码文件）→ **read 合理**。
- **大文件 / 整个目录 / 大量数据 / 需提取统计汇总** → 用 **ctx_***（ctx_index + ctx_search / ctx_execute_file / ctx_execute）。
- **自我调控**：若本会话你已 read 了**很多文件**（或连续读同一目录多个文件），说明你很在广度通读——改为 **ctx_index(该目录) 一次入库 + 多次定向 ctx_search**，别逐个 read 通读。

## 工具选择层级（tool_selection_hierarchy）
0. **MEMORY** 恢复/压缩后：ctx_search(sort:"timeline", source:["memory:"]) 先查既往决策/约束/用户要求，再向用户提问（勿重复已决定事项）
1. **GATHER** 并行收集：ctx_batch_execute(commands, queries)（跑命令 + 自动入库 + 同轮检索，一次往返）
2. **FOLLOW-UP** 追问：ctx_search(queries:["q1","q2"]) 相关问题一次批量问清（勿多次单查）
3. **PROCESSING** 加工：ctx_execute(language, code) | ctx_execute_file(path, code) 只 console.log 答案

## ctx_commands（用户触发词 → 工具）
- "ctx stats" / 问节约统计 → 调 ctx_stats，原样展示
- "ctx doctor" / 自检 → 调 ctx_doctor
- "ctx purge" / 清空知识库 → 调 ctx_purge（不可逆，先向用户确认）
- 压缩/恢复后：知识库保留，无需重建；要全新开始才 ctx_purge

## 白名单（原生工具的合法场景）
- 文件写/状态变更：Write / Edit / git add|commit|push / mkdir / mv / cp / rm / cd / pwd / kill / npm install / echo
- 确定的小输出观察：pwd / 干净 git status / whoami
- 编辑文件：Read（Edit 需要精确字节在上下文）

## 决策树（意图 → 工具）
- 读文件**做分析/摘要/抽取/统计** → ctx_execute_file(path, code)（FILE_SRC 引用内容，只回答案）
- 读文件**只是看懂内容/精确几处**（小文件）→ read
- **整目录/多文件整体理解** → ctx_index(目录) → ctx_search(queries)
- 跑命令 / 调 API、要处理输出 → ctx_execute(language:"js"|"${lang}", code)
- 并行多命令 + 同轮检索 → ctx_batch_execute(commands, queries)
- 抓网页 / 外部文档 → ctx_fetch_and_index(urls) → ctx_search(queries)
- 只需看短固定输出（git status 干净 / pwd / whoami）→ Bash
- 编辑文件 → Read + Edit/Write
- 数据已在上下文 → 直接用，不要 ctx_index(content:...) 重复索引

## 触发短语（遇到即用 ctx_*，不用问）
analyze logs · summarize output · process data · parse JSON · filter results · check build output · run tests · git log / diff · list containers · disk usage · fetch docs · index documentation · call API · count lines · codebase statistics · dependency audit · 任何可能超 ~20 行的工具输出

## Do NOT attempt (host-denied)
- curl / wget / inline-fetch → 用 ctx_fetch_and_index
- read > ${threshold} 字节(≈${thresholdTokens} tokens) whole → denied；用 ctx_index+ctx_search，或 read 带**有界** offset/limit（limit ≤ ${threshold}）
- ctx_* 的 shell 路由默认关闭 → 用 js/ts，或 ctx_fetch_and_index

## ctx_execute vs run_code
ctx_execute = context-mode 受引导的 codeRuntime 封装（带记账/批量/记忆/改道）；run_code = DSH 原生沙箱。底层同 codeRuntime；优先 ctx_execute。

## when_not_to_use
- ctx_search：已有确切内容时；定向 read offset/limit 更省时
- ctx_execute：纯抓取/下载用 ctx_fetch_and_index；需 shell 且无审批时

## File writing policy
写文件用原生 Write/Edit；ctx_execute 是资源隔离（空环境/heap cap/硬中断）非数据沙箱，信任姿态与 bash 同级，**不承诺**程序无法读/写宿主文件。

## 检索预算
ctx_search 默认 budget ${budget} 字节，只回命中片段；先索引再检索，重复索引重复计入。

## 信任文档
${trusted} 可全量读，无需先索引（仍设上限防极端大文档）。`
}

export function buildLean(deps: AdviceDeps): () => string {
  const threshold = deps.maxReadBytesBeforeAsk
  return () => `Context-mode (MANDATORY): 看懂少量小文件（≤${threshold} 字节且要理解语义）→ read 合理；大文件/整目录/大量数据/提取统计 → ctx_*（ctx_index+ctx_search / ctx_execute_file / ctx_execute）。
- 读文件做分析/摘要/统计 → ctx_execute_file；整目录/多文件 → ctx_index(目录)+ctx_search；跑命令/调 API 要处理 → ctx_execute；并行+检索 → ctx_batch_execute；抓网页 → ctx_fetch_and_index。
- 本会话已 Read 了很多文件 → 改用 ctx_index(目录)+ctx_search。
- 大文件 > ${threshold} 字节：先 ctx_index 再 ctx_search；确需分段用 read 带**有界** offset/limit（limit ≤ ${threshold}）。
- 计算/分析用 ctx_execute(language:"ts", code) 只 console.log 答案；批量用 ctx_batch_execute。
- 抓网页用 ctx_fetch_and_index（不要 curl/wget）。
- 层级：0 记忆恢复(先 ctx_search timeline memory:) → 1 并行收集(ctx_batch_execute) → 2 追问(ctx_search queries 批量) → 3 加工(ctx_execute/ctx_execute_file)。
- "ctx stats" / "ctx doctor" / "ctx purge" → 调对应工具。`
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
