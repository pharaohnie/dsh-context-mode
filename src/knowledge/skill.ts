// knowledge/skill.ts — context-mode 软触发 SKILL（P1-1）
// 对齐官方 context-mode：把「何时用 ctx_*」从常驻 advice 文本抽出来，作为一个可被模型按描述软触发的真实 skill。
// DSH skills 服务是可选服务（ctx.get('skills')），缺失则静默降级（不阻塞 apply；此时 advice.ts 的常驻 section 仍是兜底）。
// name 必须符合 kebab-case（isSkillName）；description 承载触发短语，是模型软触发的依据。
//
// 单一权威：SKILL.md 文件（<插件根>/skills/context-mode/SKILL.md）随插件分发，启动时读取正文注册；
// 文件缺失/解析失败回退到下方的硬编码 SKILL_DESCRIPTION/SKILL_BODY（保持不因文件问题丢 skill）。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 从 import.meta.url 定位插件根（本文件位于 <插件根>/src/knowledge/）。 */
function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** context-mode skill 的描述清单（软触发依据，对齐官方 SKILL frontmatter description 的短语集）。 */
export const SKILL_DESCRIPTION =
  'Use when analyzing/summarizing/processing/profiling large data or files, parsing JSON/logs, filtering results, ' +
  'checking build output, running tests, git log/diff, listing containers, disk usage, counting lines, codebase statistics, ' +
  'dependency audit, fetching/indexing docs or web pages, calling an API, or any tool output that would exceed ~20 lines — ' +
  'anything where reading the whole thing into context would flood the window. ' +
  'Contains guidance to route big reads to indexes/retrieval and data processing to the sandbox (Think-in-Code). ' +
  '触发短语（中文）：分析/统计/处理/汇总/抽取/过滤/比较/搜索/解析/转换 数据或大文件；看得见的大输出、日志、命中等。'

/** context-mode skill 正文兜底（SKILL.md 文件缺失时使用；与 advice.ts 的 MANDATORY 常驻块一致但可被按需加载）。
 *  R4-2（D-M5）：阈值参数化，不再硬编码 51200。 */
export function buildSkillBody(threshold = 51200): string {
  return `# context-mode routing

## 核心原则
让越少原始字节进上下文越好。**用代码算，而不是把数据读进来。**

## 何时用 ctx_*
- 分析/统计/过滤/比较/搜索/解析/转换数据 → 用 \`ctx_execute(language:"ts", code)\` 写程序并只 \`console.log\` 答案，原始数据留在沙箱。
- 读大文件 / 整个目录 / 大量数据 / 需提取统计汇总 → \`ctx_index\` + \`ctx_search\`（或 \`ctx_execute_file\`）。
- 抓网页 / 外部文档 → \`ctx_fetch_and_index\` → \`ctx_search\`。
- 并行多段计算 + 同轮检索 → \`ctx_batch_execute(commands, queries)\`。

## 何时直接 read（合理，勿绕道）
- 看懂少量小文件（单个 ≤ ${threshold} 字节）且你要理解其语义/精确内容（如读几行配置、看一个源码文件）→ \`read\` 合理。
- 带**有界** \`offset/limit\`（limit ≤ ${threshold}）的精确读、信任文档（README.md/CHANGELOG.md/LICENSE/AGENTS/package.json，去扩展名匹配）→ 直接 \`read\`。
- 找已索引内容的确切片段 → \`ctx_search\`；已有确切内容时定向 read 更省。

## 白名单（原生工具的合法场景）
文件写/状态变更（Write/Edit/git add|commit|push/mkdir/mv/cp/rm/cd/pwd/kill/npm install/echo）、小的确定输出（pwd/干净 git status/whoami）、编辑文件（Read + Edit）。

## Do NOT
- \`curl\` / \`wget\` / \`inline-fetch\` → 用 \`ctx_fetch_and_index\`。
- 一次整读 > ${threshold} 字节 → 用 \`ctx_index\`+\`ctx_search\`，或 \`read\` 带**有界** offset/limit（limit ≤ ${threshold}）。
- \`ctx_* 的 shell 路由已被显式关闭 → 用 js/ts，或 \`ctx_fetch_and_index\`。

## 自我调控
若本会话已 read 了很多文件（或连读同一目录多个文件），说明在广度通读 → 改用 \`ctx_index(该目录)\` 一次入库 + 多次定向 \`ctx_search\`。
`
}
export const SKILL_BODY = buildSkillBody() // 兜底（默认阈值 51200；生产由 config 注入）

/** SKILL.md 所在路径（随插件分发的静态文件）。 */
export function skillFilePath(): string {
  return path.join(pluginRoot(), 'skills', 'context-mode', 'SKILL.md')
}

/** 解析 SKILL.md frontmatter 的 name/description/whenToUse（固定字段的轻量解析，不引入 yaml 依赖）。
 *  支持 description 的块标量（YAML `|` 多行）与单行两种写法；返回 { description, whenToUse, body }；失败返回 null（调用方回退硬编码）。
 *  R4-2（D-M5）：body 中的 {{maxReadDenyBytes}}/{{searchBudgetBytes}} 占位符按运行时配置替换。 */
export function loadSkillFile(vars: { threshold: number; budget: number } = { threshold: 51200, budget: 12000 }): { description: string; whenToUse: string; body: string } | null {
  const file = skillFilePath()
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    if (!raw.startsWith('---')) return null
    const end = raw.indexOf('\n---', 4)
    if (end < 0) return null
    const fm = raw.slice(4, end)
    let body = raw.slice(end + 4).trim()
    body = body.replaceAll('{{maxReadDenyBytes}}', String(vars.threshold)).replaceAll('{{searchBudgetBytes}}', String(vars.budget))
    // description：支持 `description: |` 块标量（后续缩进行全部并入）与单行两种写法
    let description = ''
    const descLine = fm.match(/^description:\s*(.*)$/m)
    if (descLine) {
      const inline = descLine[1].trim()
      if (inline === '|') {
        // 块标量：抓 description 之后、下一个顶层键（^word: 开头）之前的缩进行
        const block = fm.slice(descLine.index! + descLine[0].length)
        const m = block.match(/^(\s+.+\n?)+/m)
        if (m) description = m[0].split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
      } else {
        description = inline
      }
    }
    const when = (fm.match(/^whenToUse:\s*(.+)$/m)?.[1] ?? '').trim()
    if (!description || !body) return null
    return { description, whenToUse: when || '把大文件/大输出换成索引+检索、把数据处理换成沙箱计算时（Think-in-Code），避免上下文洪水。', body }
  } catch {
    return null // 读取失败 → 回退硬编码
  }
}

export interface SkillDeps { enabled: boolean; config?: { maxReadDenyBytes?: number; maxReadBytesBeforeAsk?: number; searchBudgetBytes?: number } }

/** 注册 context-mode 软触发 skill（DSH skills 可选；缺失降级）。 */
export function registerSkill(ctx: { get(name: string): unknown }, deps: SkillDeps) {
  if (!deps.enabled) return
  const skills = ctx.get('skills') as { register?: (skill: unknown) => () => void } | undefined
  if (!skills || typeof skills.register !== 'function') return // 可选服务缺失 → 静默降级
  // 文件优先（单一权威，随插件分发可编辑）；缺失回退硬编码兜底。R4-2：阈值由配置注入。
  // P2-3：阈值键名与 SKILL.md 占位符 {{maxReadDenyBytes}} 对齐（旧键 maxReadBytesBeforeAsk 兼容回退）。
  const threshold = deps.config?.maxReadDenyBytes ?? deps.config?.maxReadBytesBeforeAsk ?? 51200
  const budget = deps.config?.searchBudgetBytes ?? 12000
  const loaded = loadSkillFile({ threshold, budget })
  const description = loaded?.description ?? SKILL_DESCRIPTION
  const whenToUse = loaded?.whenToUse ?? '把大文件/大输出换成索引+检索、把数据处理换成沙箱计算时（Think-in-Code），避免上下文洪水。'
  const content = loaded?.body ?? buildSkillBody(threshold)
  try {
    skills.register({
      name: 'context-mode',
      description,
      whenToUse,
      content,
      // SkillSummary 必需字段：source 为来源桶（runtime 注册语义）；缺失会导致 "source must be a string" 校验失败。
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-context-mode',
    })
  } catch { /* 注册失败忽略（可能同名；advice.ts 常驻 section 仍是兜底） */ }
}
