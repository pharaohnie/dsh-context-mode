# dsh-context-mode

DSH（DeepSeek Harness）的上下文减负插件。核心就一句话：让越少的原始字节进上下文越好。

它做三件事：大文件、网页索引进本地知识库，用检索片段代替整读；curl/wget、超长 read 这类洪水工具拦下来改道；数据处理丢进沙箱，只把答案带回来。它不做别的。

## 安装

### 作为 profile 插件（本地 link 形态）

在 DSH profile 的 `package.json` 里：

1. `dependencies` 加 `"dsh-context-mode": "link:/绝对路径/到/插件目录"`（或 `../` 相对路径）。
2. `dsh.profile.bundles` 数组加 `"dsh-context-mode"`。
3. 在 profile 目录跑 `pnpm install`。
4. 重启 DSH，用 `ctx_doctor` 自检。`codeRuntime`、知识库、read 门禁都该是 ✓。

### 作为发布包

`dsh plugin add dsh-context-mode`（或在 profile `dependencies` 加包名），在 `dsh.profile.bundles` 登记后重启。

> 依赖自愈：DSH 经 `npx` 更新后，插件 `node_modules` 可能还指着旧 npx 缓存，报 `ERR_MODULE_NOT_FOUND`。跑一次插件目录的 `./relink-dsh-context-mode.sh`（或重新 `pnpm install`）即可。脚本只重设那个 symlink，不动配置和数据。

## 原理

### 1. 知识库：索引 + 检索

`ctx_index` 把本地文件或目录切片入库，`ctx_fetch_and_index` 抓网页转 markdown 后同样入库。切片按标题分块、保留代码块原文（单块约 8000 字节），存进 SQLite 的 FTS5 双表：porter 词根处理英语词形，trigram 子串兜住中文和模糊匹配，两个排名按 RRF 合并。

`ctx_search` 只返回命中片段，默认预算 12000 字节，支持 `queries` 批量、`sort`（relevance / timeline）、`source` 按 ref 前缀过滤。搜索带 FloodGuard：按 agent 会话分桶节流，窗口 60 秒内前 3 次放行，之后返回量减半，超过 8 次硬拦。多个子代理并行时各算各的预算，不会互相挤占。

入库内容有 TTL（默认 24 小时，可覆盖），过期惰性清理；重复索引同一来源会先删旧 chunk，知识库不会越用越大。`ctx_purge` 全清，不可逆，用之前想清楚。

### 2. 路由拦截：把洪水挡在门外

挂在 `tools/pre-execute` 上，命中规则直接 deny，放行走 `next()`。

- **bash 洪水硬 deny**：curl / wget / inline-fetch / aria2c / nc / ncat，确定性拦截。词表识别处理了 `sudo`、`env`、`bash -c`、重定向、路径 basename 这类绕行写法。
- **read 整读门禁**：文件超过 51200 字节（约 50KB）、且不带**有界** `offset/limit`（limit ≤ 阈值）的整读，拒绝并给出引导。信任文档（README / CHANGELOG / LICENSE / AGENTS / package.json，去扩展名匹配）可整读，上限放宽到阈值 × 2。
- **长 bash 软引导**：命令超过 1000 字节时，有审批通道就 ask，没有就放行。软引导绝不误拦合法命令。
- **结构白名单**：pwd / echo / ls / wc / whoami / date 这类无害单命令，零摩擦放行。
- **ctx_execute\* 的 shell 路由默认关**，引导用 ts/js 或 `ctx_fetch_and_index`。

deny 的 reason 直接告诉模型下一步该用什么，不是干巴巴一句"拒绝"。

### 3. 沙箱执行：Think in Code

`ctx_execute` 复用 DSH 的 `codeRuntime`（worker 隔离、空环境、heap 上限、硬中断），模型写一段程序，只把 `console.log` 和返回值得回来。`ctx_execute_file` 读一个文件的内容作为 `FILE_SRC` 数据、对它跑分析代码，比如"统计这个日志里 error 出现几次"，文件本体不进上下文。`ctx_batch_execute` 并行跑多段程序，结果自动入库，同一轮还能用 `queries` 检索。

### 附加

- **`ctx_doctor`**：诊断装配状态。硬依赖、可选服务、门禁 armed、FTS5 冒烟、知识库分片、实际生效的 env 覆盖，一行一个 ✓ 或 ✗。
- **`ctx_stats`**：节约台账。已索引、检索返还、拒绝洪水（read 实际拦截按文件去重；curl/wget 只有命令串长度，属下界）、沙箱执行次数、记忆捕获量，还有 kept_out_pct。
- **会话连续性**：`agent/session-start` 时把最近事件蒸馏成摘要注入。最近用户意图必恢复，外加最近错误、文件、进度、工具；压缩后不丢上下文。注入内容带"插件生成"标注，不会冒充用户指令。
- **会话记忆捕获**：`memoryCapture` 默认关（隐私考虑）。开启后捕获 user-prompt 和 turn-stopping 时的决策/约束（关键词启发式，误判漏判已知），恢复时先检索记忆再让模型问话，不重复已决定的事。
- **软触发 skill**：`skills/context-mode/SKILL.md` 随插件分发，模型可按描述软触发"何时用 ctx_*"的完整指引；常驻的 systemPrompt section 是兜底。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `ctx_index` | 索引本地文件 / 目录 |
| `ctx_search` | 检索，只回命中片段 |
| `ctx_fetch_and_index` | 抓网页转 markdown 入库 |
| `ctx_purge` | 清空知识库（不可逆） |
| `ctx_execute` | 沙箱跑程序，只回答案 |
| `ctx_execute_file` | 文件内容作数据跑分析 |
| `ctx_batch_execute` | 并行多段 + 同轮检索 |
| `ctx_doctor` | 自检 |
| `ctx_stats` | 节约台账 |

## 配置

Schemastery schema 定义，默认知识库在 `~/.context-mode/content`。大部分开关可用 `CONTEXT_MODE_*` 环境变量覆盖，优先级：显式配置 > env > 默认值。

几个默认值得先知道：

- `routingEnabled: true`，总开关
- `maxReadBytesBeforeAsk: 51200`，read 整读阈值（`maxReadDenyBytes` 是语义对齐的新键，优先于旧名）
- `executeAllowShell: false`，shell 路由默认关
- `memoryCapture: false`，记忆捕获默认关
- `securityEnabled: false`，安全基线默认关，且当前只作用于 read 的 file_path
- `subagentGuidance: false`，子代理守卫默认关

完整清单看 `src/config.ts`，每个键都有注释。

## 诚实边界

这个插件是"引导型省"：把有界整读引导到精准检索，把数据处理引导到沙箱。它不做 `read` 之外的事后压缩，也不会声称省了 98%。`ctx_stats` 把两个口径并列展示：measured 只算 read 侧能精确统计的部分，total 含估算和下界，不混着报。

另外两点：`codeRuntime` 是资源隔离，不是数据沙箱，信任姿态和 bash 同级，不承诺程序无法读/写宿主文件。`read` 自带上限约 50KB，超限本来就会被截断，这个插件只是在那之前把路指好。

## 运行环境

DSH `v0.1.1-rc.2`，Node ≥ 24（`node:sqlite` 自带 FTS5，免编译；type-stripping 直接加载 `.ts`）。知识库走 WAL 模式，多进程共享时防写锁。

纯逻辑回归跑 `node scripts/smoke.ts`：覆盖 FloodGuard 分桶、chunkStats、advice 构建、SSRF 防护、FTS5 非法查询转义、read 门禁判定。不需要 DSH 运行时，Node 直跑。
