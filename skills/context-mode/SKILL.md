---
name: context-mode
description: |
  把大文件/大输出换成索引+检索、把数据处理换成沙箱计算（Think-in-Code），避免上下文洪水。
  Use when analyzing/summarizing/processing/profiling large data or files, parsing JSON/logs,
  filtering results, checking build output, running tests, git log/diff, listing containers,
  disk usage, counting lines, codebase statistics, dependency audit, fetching/indexing docs
  or web pages, calling an API, or any tool output that would exceed ~20 lines — anything
  where reading the whole thing into context would flood the window.
  触发短语（中文）：分析/统计/处理/汇总/抽取/过滤/比较/搜索/解析/转换 数据或大文件；看得见的大输出、日志、命中等。
whenToUse: 需要处理大文件/大输出、做数据统计或摘要、抓取并检索外部文档、或任何会把上下文窗口撑大的读取/命令时。
# metadata 与 user-invocable 仅供人读；实际注册值以 src/knowledge/skill.ts 硬编码为准
metadata:
  provider: dsh-context-mode
  version: 0.1.0  # 随 package.json version 同步
user-invocable: true
---

# Context Mode：大输出与大数据的默认处理方式

## 核心原则

让越少原始字节进上下文越好。**用代码算，而不是把数据读进来**（Think-in-Code）。原始数据留在沙箱/知识库，只把 `console.log`/返回值的答案带回上下文。

## 触发判定（该 read 还是该用 ctx_*？）

| 场景 | 工具 | 说明 |
|---|---|---|
| 看懂少量小文件（单个 ≤ {{maxReadDenyBytes}} 字节且要理解语义，如读配置/源码） | `read` | 直接读合理，勿绕道 |
| 编辑文件（Edit 需要精确字节匹配） | `read` + `Edit` | read 合法 |
| 带 `offset/limit` 且**单段有界**（limit ≤ 阈值）的精确读 | `read` | 只放行有界分段读，超大 limit 会被拒 |
| 信任文档（README.md/CHANGELOG.md/LICENSE/AGENTS/package.json，去扩展名匹配、受 headroom 限制） | `read` | 可全量读（仍设上限防极端大文档） |
| 大文件 / 整个目录 / 大量数据 / 需提取统计汇总 | `ctx_index` + `ctx_search`，或 `ctx_execute_file` | 索引后检索片段 |
| 读文件做分析/摘要/抽取/统计 | `ctx_execute_file(path, code)` | FILE_SRC=完整内容字符串（勿再读文件/当路径），只回答案 |
| 跑命令 / 调 API 要处理输出 | `ctx_execute(language, code)` | 沙箱里跑，只打印结论 |
| 并行多命令 + 同轮检索 | `ctx_batch_execute(commands, queries)` | 一次往返，自动入库 |
| 抓网页 / 外部文档 | `ctx_fetch_and_index(urls)` → `ctx_search` | 原始页面字节不进上下文 |
| 只看短固定输出（pwd / 干净 git status / whoami） | `Bash` | 白名单零摩擦 |
| 文件写/状态变更（Write/Edit/git/mkdir/mv/cp/rm/npm install/echo） | `Bash`/原生 | 白名单合法场景 |
| 数据已在上下文 | 直接用 | 不要 ctx_index(content:...) 重复索引 |

## 工具选择层级

0. **MEMORY** 恢复/压缩后：`ctx_search(sort:"timeline", source:["memory:"])` 先查既往决策/约束/用户要求，再向用户提问。
1. **GATHER** 并行收集：`ctx_batch_execute(commands, queries)`（跑命令 + 自动入库 + 同轮检索）。
2. **FOLLOW-UP** 追问：`ctx_search(queries:["q1","q2"])` 相关问题一次批量问清，勿多次单查。
3. **PROCESSING** 加工：`ctx_execute` / `ctx_execute_file` 只 `console.log` 答案。

## ctx_commands（用户触发词 → 工具）

- "ctx stats" / 问节约统计 → 调 `ctx_stats` 并原样展示。
- "ctx doctor" / 自检 → 调 `ctx_doctor`。
- "ctx purge" / 清空知识库 → 调 `ctx_purge`（不可逆，先向用户确认）。
- 压缩/恢复后：知识库保留，无需重建；要全新开始才 `ctx_purge`。

## 自动触发场景（遇到即用 ctx_*，不用问）

- **API 调试**：打接口、看响应、找响应里的 bug
- **日志分析**：看日志、什么错误、读 access.log、调试 5xx
- **测试运行**：跑测试、是否通过、测试输出
- **Git 历史**：最近提交、git log、分支 diff
- **数据检查**：看 CSV、解析 JSON、分析配置
- **基础设施**：列容器、看 pod、S3 桶、运行中的服务
- **依赖审计**：查依赖、过期包、安全审计
- **构建输出**：构建项目、查警告、编译错误
- **代码度量**：数行数、找 TODO、函数数、分析代码库
- **文档查询**：查文档、看 API 参考、找示例
- 任何可能超 ~20 行的工具输出

## 语言选择

| 场景 | 语言 | 理由 |
|---|---|---|
| HTTP/API 调用、JSON | `ts`/`js` | 原生 fetch、JSON.parse、async/await |
| 数据分析、CSV、统计 | `ts`/`js` | 原生 JSON/数组方法 |
| 管道命令（grep/awk/jq） | `shell` | 默认开启 `executeAllowShell`（关闭时改用 ts 或 ctx_fetch_and_index） |
| 读宿主文件系统 / npm 模块 | `ts`/`js` | 用 `const fs = await import("node:fs")`（无 require/静态 import）；管道命令仍走 `shell` |

> 注：`ctx_execute` 的 shell 路由**默认开启**（`executeAllowShell=true`）。当该开关被显式设为 false 时，shell 代码会被拒绝，此时改用 `ts` 或 `ctx_fetch_and_index`。
>
> **沙箱契约**：`code` 是 async function body（顶层 await/return 可用），**无 require/静态 import**；读宿主文件用 **`await import("node:fs")`**；`ctx_execute_file` 的 `FILE_SRC` 是文件**完整内容（string）**，不要再读文件、不要当路径用。

## 搜索策略（ctx_search）

- 用 2–4 个具体技术词作 query（BM25 OR 语义，命中多词排名更高）。
- **一次把所有问题放 `queries` 数组**——不要多次单独 ctx_search。
- 多文档时用 `source` 前缀过滤避免串扰：`source: "Node"` 匹配 `Node.js v22 CHANGELOG`。
- 默认预算 {{searchBudgetBytes}} 字节，只回命中片段；先索引再检索，重复索引重复计入。
- 检索有 FloodGuard 节流（按会话/子代理分桶）：过于频繁会被 taper/block，优先批量 queries。

## 关键规则

1. **Always console.log/print your findings**——stdout 是唯一进上下文的东西；无输出 = 白调用。
2. **写分析代码，不是数据转储**——先过滤/计数/聚合再打印结论，别 `console.log(JSON.stringify(data))`。
3. **输出要具体**——带 id、行号、精确值，不只是计数。
4. **编辑文件用原生 Read**——ctx_* 是分析，不是编辑。
5. **写文件用原生 Write/Edit**——ctx_execute/ctx_execute_file 的沙箱不持久化到宿主文件系统（资源隔离，非数据沙箱；不承诺程序无法读/写宿主文件）。
6. **不要重复索引已在上下文的数据**——已加载直接用；要索引先落盘再 `ctx_index(path)`（本插件 `ctx_index` 只接受 `paths`/目录，无 content 参数）。
7. **抓网页用 `ctx_fetch_and_index`，不要 curl/wget**（curl/wget 被门禁硬拦）。

## 反模式（Anti-Patterns）

- 用 Bash `cat 大文件` → 整文件进上下文。改用 `ctx_execute_file`。
- 用 Bash `curl http://...` → 50KB 洪水。改用 `ctx_execute` 内 fetch 或 `ctx_fetch_and_index`。
- 用 Bash `gh pr list` / `kubectl get pods` 拿原始输出 → 用 `ctx_execute` 加过滤/`--jq` 只打印摘要。
- `| head -20` 截断输出 → 丢数据；用 `ctx_execute` 分析全部再打印摘要。
- 把 MCP/工具响应再喂给 `ctx_index` 的路径 → 上下文翻倍；已加载直接用或先落盘再索引。
- 忽略 `browser_snapshot` 等大输出工具 → 其输出可能 100K+ token；存文件 → `ctx_index(path)` → `ctx_search`。
- 把 `ctx_stats` 当能重置的工具 → 它只读；清库用 `ctx_purge`。
- 在 code 里写 `require("node:fs")` / `import fs from "node:fs"` → 沙箱无 require/静态 import（`ReferenceError`）。读宿主文件改用 **`const fs = await import("node:fs")`**；分析已有内容直接用 FILE_SRC；管道/命令行走 `language:"shell"`。

## 会话恢复

- 压缩/恢复后：`ctx_search(sort:"timeline", source:["memory:"])` 检索本会话最近决策/约束，再向用户提问，不重复已决定事项。
- 子代理：大文件/大输出用 ctx_index+ctx_search 或 ctx_execute_file，不要整读。
