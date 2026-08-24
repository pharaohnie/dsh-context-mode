// knowledge/skill.ts — context-mode 软触发 SKILL（P1-1）
// 对齐官方 context-mode：把「何时用 ctx_*」从常驻 advice 文本抽出来，作为一个可被模型按描述软触发的真实 skill。
// DSH skills 服务是可选服务（ctx.get('skills')），缺失则静默降级（不阻塞 apply；此时 advice.ts 的常驻 section 仍是兜底）。
// name 必须符合 kebab-case（isSkillName）；description 承载官方那批触发短语，是模型软触发的依据。

/** context-mode skill 的描述清单（软触发依据，对齐官方 SKILL frontmatter description 的短语集）。 */
export const SKILL_DESCRIPTION =
  'Use when analyzing/summarizing/processing/profiling large data or files, parsing JSON/logs, filtering results, ' +
  'checking build output, running tests, git log/diff, listing containers, disk usage, counting lines, codebase statistics, ' +
  'dependency audit, fetching/indexing docs or web pages, calling an API, or any tool output that would exceed ~20 lines — ' +
  'anything where reading the whole thing into context would flood the window. ' +
  'Contains guidance to route big reads to indexes/retrieval and data processing to the sandbox (Think-in-Code). ' +
  '触发短语（中文）：分析/统计/处理/汇总/抽取/过滤/比较/搜索/解析/转换 数据或大文件；看得见的大输出、日志、命中等。'

/** context-mode skill 正文：何时用 ctx_*（完整指引），与 advice.ts 的 MANDATORY 常驻块保持一致但可被按需加载。 */
export const SKILL_BODY = `# context-mode routing

## 核心原则
让越少原始字节进上下文越好。**用代码算，而不是把数据读进来。**

## 何时用 ctx_*
- 分析/统计/过滤/比较/搜索/解析/转换数据 → 用 \`ctx_execute(language:"ts", code)\` 写程序并只 \`console.log\` 答案，原始数据留在沙箱。
- 读大文件 / 整个目录 / 大量数据 / 需提取统计汇总 → \`ctx_index\` + \`ctx_search\`（或 \`ctx_execute_file\`）。
- 抓网页 / 外部文档 → \`ctx_fetch_and_index\` → \`ctx_search\`。
- 并行多段计算 + 同轮检索 → \`ctx_batch_execute(commands, queries)\`。

## 何时直接 read（合理，勿绕道）
- 看懂少量小文件（单个 ≤ 51200 字节）且你要理解其语义/精确内容（如读几行配置、看一个源码文件）→ \`read\` 合理。
- 带 \`offset/limit\` 的精确读、信任文档（README/CHANGELOG/LICENSE/AGENTS/package.json）→ 直接 \`read\`。
- 找已索引内容的确切片段 → \`ctx_search\`；已有确切内容时定向 read 更省。

## 白名单（原生工具的合法场景）
文件写/状态变更（Write/Edit/git add|commit|push/mkdir/mv/cp/rm/cd/pwd/kill/npm install/echo）、小的确定输出（pwd/干净 git status/whoami）、编辑文件（Read + Edit）。

## Do NOT
- \`curl\` / \`wget\` / \`inline-fetch\` → 用 \`ctx_fetch_and_index\`。
- 一次整读 > 51200 字节 → 用 \`ctx_index\`+\`ctx_search\`，或 \`read\` 带 offset/limit。
- \`ctx_* 的 shell 路由默认关闭 → 用 js/ts，或 \`ctx_fetch_and_index\`。

## 自我调控
若本会话已 read 了很多文件（或连读同一目录多个文件），说明在广度通读 → 改用 \`ctx_index(该目录)\` 一次入库 + 多次定向 \`ctx_search\`。
`

export interface SkillDeps { enabled: boolean }

/** 注册 context-mode 软触发 skill（DSH skills 可选；缺失降级）。 */
export function registerSkill(ctx: { get(name: string): unknown }, deps: SkillDeps) {
  if (!deps.enabled) return
  const skills = ctx.get('skills') as { register?: (skill: unknown) => () => void } | undefined
  if (!skills || typeof skills.register !== 'function') return // 可选服务缺失 → 静默降级
  try {
    skills.register({
      name: 'context-mode',
      description: SKILL_DESCRIPTION,
      whenToUse: '把大文件/大输出换成索引+检索、把数据处理换成沙箱计算时（Think-in-Code），避免上下文洪水。',
      content: SKILL_BODY,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-context-mode',
    })
  } catch { /* 注册失败忽略（可能同名；advice.ts 常驻 section 仍是兜底） */ }
}
