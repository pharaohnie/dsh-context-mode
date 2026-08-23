# dsh-context-mode

给 DeepSeek Harness 的上下文窗口减负：复刻 upstream `mksglu/context-mode` 的四件套价值，但用 **DSH 原生 Cordis 插件**实现（而非外部 MCP + hooks 劫持）。

> 只约束数据去向，不约束文风。插件只管内容如何进入/流出上下文，不规定你怎么写代码或措辞。

## 三大功能

| 块 | 工具 | 价值 |
|---|---|---|
| **A 知识库** | `ctx_index` / `ctx_search` / `ctx_fetch_and_index` / `ctx_purge` | 本地 `node:sqlite` + FTS5（porter + trigram）+ RRF 合并 + 标题 5x 加权。检索返回命中片段，而非整文件；`ctx_search` 支持 `queries[]` 批量、`sort`(timeline/relevance)、`source`(ref 前缀过滤) |
| **B 路由强制** | `tools/pre-execute` + `guard` + `systemPrompt.section` | curl/wget/inline-fetch 硬 deny；无界 bash 长命令 ask（无审批通道则放行+警告）；**read 整读门禁**（>阈值→deny+引导到检索）；**ctx_execute* 的 shell 路由默认关**；大输出先索引再检索指引 |
| **C 会话连续性** | `agent/session-start` + `sessionQuery` + `agent.inject` | 压缩后自动恢复最近工作状态；subagent 过滤；幂等去重 |
| **D 沙箱执行** | `ctx_execute` / `ctx_execute_file` / `ctx_batch_execute` | **Think-in-Code**：在 DSH `codeRuntime` 里跑模型写的一段程序，只把 stdout+返回值得回上下文；`ctx_execute_file` 读文件内容作数据、对其跑分析 code（非执行文件本体）；`ctx_batch_execute` 并行多段+自动索引+同轮检索 |
| **E 会话记忆** | `agent/inbox/inserted` + `agent/turn-stopping` + gate deny | 把用户提示/决策/约束/拒绝方案捕获为可检索 chunk（`memory:*`），跨 compact 可 `ctx_search`；resume 引导「先搜再问」（默认 opt-in 关，B3） |

另附 `ctx_doctor`（诊断 seam 装配 / 知识库健康 / 执行 substrate 与文件策略分开报）、`ctx_stats`（节约台账 measured/total 并列 + 上下文压力）。

## 配置（Schemastery schema）

| 字段 | 默认 | 说明 |
|---|---|---|
| `routingEnabled` | `true` | 路由强制总开关 |
| `denyCurlWget` | `true` | 硬 deny curl/wget/inline-fetch（不参与 fail-open 降级） |
| `bashNudgeMinCommandBytes` | `0` | 无界 bash 阈值（0=不触发）；超过则 ask |
| `maxReadBytesBeforeAsk` | `51200` | **整读引导（deny）阈值**：`stat.size > 该值` 才 deny+引导。对齐 read 工具自身 `readMaxBytes`（≈50KB）。注：字段名带 ask，实为 deny 阈值（语义别名 `readFloodDenyBytes`） |
| `autoGuideRead` | `true` | read「自动引导到检索」开关；`false` = read 从不门禁（回到现状）。首版只保留此总开关，无 `readRoutingMode` |
| `readAllowBounded` | `true` | 带 offset/limit 的精确读是否豁免门禁（显式分段读属合法意图，放行） |
| `trustedReadBasenames` | `['README','CHANGELOG','LICENSE','AGENTS','package.json']` | 信任文档 basename 白名单（basename 命中 + size≤headroom 双条件豁免） |
| `trustedDocHeadroom` | `4` | 信任文档可放宽到 `maxReadBytesBeforeAsk × N` |
| `executeEnabled` | `true` | ctx_execute* 沙箱执行总开关 |
| `executeDefaultLanguage` | `'ts'` | ctx_execute 缺省语言（当前 DSH 仅 TS 有 codeRuntime backend） |
| `executeAllowShell` | `false` | **默认关**：ctx_execute 的 shell 路由；`true` 才允许（gate 会对 shell code 做洪水/长命令审查） |
| `executeTimeoutMs` | `0` | 0=纯宿主预算（codeRuntime 的 computeMs/maxWallMs） |
| `executeConcurrency` | `4` | ctx_batch_execute 并发（1-8；**每个 worker 占一个空环境+heap cap，内存随 N 倍增长**，S6） |
| `memoryCapture` | `false` | **默认 opt-in 关（B3）**：会话记忆捕获开关 |
| `memoryTtlMs` | `7*86400000` | 记忆生命周期（默认 7 天，非 0；**避免永久持久化敏感内容**，B3） |
| `memoryResumeTopN` | `3` | resume 注入的近期记忆条数 |
| `memoryResumeBytes` | `800` | resume 注入的近期记忆字节预算 |
| `adviceStructured` | `true` | advice 用结构化 routing block（工具层级/禁令/when_not_to_use） |
| `adviceRich` | `true` | `false` 回退精简散文（省每步 token） |
| `accountingLedger` | `false` | 可选记账明细表（low-priority，暂未启用） |
| `knowledgeBaseDir` | `~/.context-mode/content` | 知识库目录（自建 sqlite，不经 `storageDomain`） |
| `knowledgeBaseTtlMs` | `86400000` | 默认 TTL（24h），可 per-call 覆盖 |
| `knowledgeBaseConcurrency` | `4` | 抓取并发（1-8） |
| `sessionContinuity` | `true` | 会话恢复开关 |
| `continuityTopN` | `20` | 恢复取最近 N 事件 |

## 路由强制边界（fail-open）

- `curl`/`wget`/`inline-fetch` 是**确定性洪水**：硬 `deny`，不走 fail-open。
- 无界 bash 长命令：正常情况下回 `ask`；**若 `ctx.get('approval')` 为 undefined（无审批通道），降级为「放行 + deferContext 警告」**，不阻塞 headless/CI。
- 覆盖了 ask 但审批服务存在而通道 `unavailable` 的极端情形：遵循框架 fail-closed，README 明示，不二次降级。
- 门禁自身异常一律 fail-open（`return next()`），绝不让门禁破坏一次合法工具调用。

## read 整读门禁（自动引导到检索，A.5-R5 定位）

> **定位：引导型省 / 中等增量。** read 工具**自带约 50KB 输出上限**（`readMaxBytes`），单次 read 最多回 ≈50KB（无论文件多大、单行多长），不存在「一条 read 把 MB 级文件灌进上下文」的灾难。因此本门禁不是「阻止 read 洪水」，而是「把**有界但较大（≤50KB/次）的整读**引导到精准 `ctx_search`」——省的是「整读 vs 精准检索」的差额。

只拦**文本 `read`**（`exec.name === 'read'`）；`read_image` 名称不同，天然放行（图像无检索等价物，A.5-R1）。判定在 async 的 `tools/pre-execute`（gate.ts）里做（需 `await stat`）；`ctx.tools.guard()` 是同步 `ToolGuard`（不 await），故 read 门禁的权威执行点在 pre-execute。

**阈值为 `maxReadBytesBeforeAsk`（默认 51200，对齐 `readMaxBytes`）**：`stat.size > 该值` 才触发 deny + 引导；`≤该值` 直接放行（零摩擦）。它**不是**检索粒度——`budgetBytes`（8000）/ chunker `maxBytes`（8000）是检索/分块粒度，与整读引导阈值职责分离，勿混为一谈。

**deny 即「改道」，不「禁读」**：超出阈值的整读被拒后，reason 给出四条正道——① `ctx_index`+`ctx_search`（主替代）；② `run_code` 只读必要切片并只打印结论；③ `read` 带 offset/limit 的精确读；④ 信任文档可整读。所有「想读文件」的合法意图都可经这些路径达成。

**边界表（什么不该拦）：**

| 场景 | 是否拦 | 理由 |
|---|---|---|
| `routingEnabled=false` 或 `autoGuideRead=false` | 不拦 | 规则整体关闭 |
| `read_image`（非文本 read） | 不拦 | 图像无检索等价物，不设改道 |
| 其它非 `read` 工具 | 不拦 | 只管文本 `read` |
| run_code 子分派内的 read | **按 size 判定（不豁免）** | P1：run_code 直接/间接整读大文件是绕开引导的旁路；须与普通 read 同门禁，或改带 offset/limit 读切片 |
| 带 offset/limit 的精确读 | 不拦 | 显式分段读，本身就是引导提供的替代路径 |
| 信任文档（README/CHANGELOG/LICENSE/AGENTS/package.json） | 放宽 | basename 命中 + `size ≤ maxReadBytesBeforeAsk × trustedDocHeadroom` |
| stat 失败 / 无 file_path | 不拦（fail-open） | 绝不因拿不到 size 误拒一次合法读 |
| `size ≤ 阈值` | 不拦 | 小读不计，零摩擦 |

> **运行期不能拦截的残余口（P1/R8）**：`run_code` 里**直接用 node:fs 读 + 自由打印全量**不经过 read 工具，`exec` 门禁天然看不到——这一路**不是确定性省**（非确定性省/残余口）。靠指引（§4.3：别 `fs.readFileSync` 整文件后打印全量）+ 本文档诚实标注缓解。另注：若宿主处于 `mode:'code'`，SDK 子分派所有原生调用都带 `parent`，此时「按 parent 豁免」会让门禁变 no-op——因此本门禁**不按 parent 豁免**，统一按 size 判定。

## 沙箱执行（Think-in-Code，P0）

复用 DSH 内置 `ctx.codeRuntime`（`CodeRuntime.run()`，worker-thread 隔离：每个 run 新建 isolate、空环境、heap cap、硬中断、时长预算），**不自建沙箱**。模型写一段程序（async function body，顶层 `await/return`），只把 `logs+value` 带回上下文，原始数据留在沙箱。

- `ctx_execute(language, code)`：主引擎。`language` 默认 ts；`shell` 需 `executeAllowShell=true`（默认关）。
- `ctx_execute_file(path, language?, code?)`：**读 `path` 内容作为数据（`FILE_SRC`），对其运行分析 `code`**，而非执行目标文件本体（源文件多为非入口，执行会失败）。`code` 缺省返回 `FILE_SRC.length`。
- `ctx_batch_execute(commands, queries?)`：并行多段（`concurrencyPool` 夹 1-8）、结果自动入库（`batch:<sid>:<hash>`）、同轮 `queries` 检索命中。

> **安全边界（B1，诚实）**：`codeRuntime` 是**资源隔离（非数据沙箱）**；信任姿态与 **bash 同级**（运行的是模型自己写的程序），**不承诺**程序无法读/写宿主文件（worker 用 `new AsyncFunction` 在 worker 主 realm 运行、未清 Node 全局，可经 `process`/`globalThis`/动态 `import('node:fs')` 触达宿主 FS）。默认不注入 `fs`/`writeText` binding、`ctx_execute_file` 只经 `ctx.fs.readText` 读——这是**设计取向（减小攻击面）**，**不是**安全边界。`ctx_execute(shell)` 默认拒绝（`executeAllowShell=false`）。
> **内存提示（S6）**：`ctx_batch_execute` 并发 N 个会同时占 N 个空环境+heap cap，宿主内存随 N 倍线性增长——`concurrency` 夹 1-8，CI/大并发场景调低 `executeConcurrency`。

## 会话记忆（P1b，默认 opt-in 关）

把「用户提示/决策/约束/拒绝方案」捕获为知识库可检索 chunk（`ref: memory:<kind>:<sid>`），跨 compact 可 `ctx_search(source:["memory:decision",...])`；resume 时引导「先搜再问」+ 注入近期记忆。

- 捕获入口：`agent/inbox/inserted`（user-prompt）、`agent/turn-stopping`（decision/constraint，关键词/模型标记启发式）、gate deny（rejected-approach）。
- **隐私（B3）**：默认 **`memoryCapture:false`**（opt-in）；`memoryTtlMs` 默认 7 天（非 0，控制生命周期）；捕获过滤插件合成消息（`source.kind==='plugin'`）+ subagent 会话；**用户消息/决策/约束会写入本地知识库 `~/.context-mode/content/`，可能含敏感内容**，启用时注意；`ctx_purge` 可整体清空。
- **诚实边界**：无上游 SessionDB 的 13 类自动抽取，「决策」依赖关键词/模型标记**启发式**分类（可检索即可，非全语义理解）。

## 节约口径（ctx_stats）

`ctx_stats` 输出，口径诚实（**measured 与 total 并列，勿单列 measured 当结论，S7**）：

| 条目 | 键 | 口径 |
|---|---|---|
| 已索引 | `indexed_bytes` | 入库 body 字节（粗差） |
| 检索返还 | `search_bytes` | 返还模型片段字节 |
| read 拦截 | `read_denied_bytes` | **真实 stat.size，按文件去重（精确，measured）** |
| curl/wget 拦截 | `denied_bytes` | 命令串长度，**下界**（框架不报告本应输出字节） |
| 沙箱执行 | `execute_runs`/`execute_log_bytes` | 次数 + 返还日志字节（**成本侧**，不计入精确节约，明示 estimate） |
| 记忆捕获 | `memory_chunks`/`memory_bytes` | 记忆 chunk 数与字节 |

- `kept_out_pct_measured = read_denied / (read_denied + search + execute_log)` —— **仅 read 侧检测口径**，非全量节约，可能被样本偏差误导。
- `kept_out_pct_total`（含 `indexed-search` 粗差 + `denied_bytes` 下界）与之**并列展示**，各附「含下界/估算」说明。

## 装配

### scratch 形态（M0-M3 开发）

```yaml
# scratch-plugin/cordis.yml
- insert:
    - id: context-mode
      name: '/abs/path/context-mode/src/index.ts'
      config: { routingEnabled: true }
```

**前置条件**（本环境是 npm 安装形态，非 monorepo）：
- `scratch-plugin/node_modules` → symlink 到 DSH 安装的 `node_modules`（否则裸导入 `@deepseek-ai/*` 报 `ERR_MODULE_NOT_FOUND`）。
- `.ts` 由 Node 24 原生剥离类型直载；**只支持 erasable 语法**（无 `enum`/namespace）；**相对导入必须带 `.ts` 后缀**。
- 启动（后台实例，端口避开默认 GUI）：`node <dsh-install>/lib/bin.js web --patch ./scratch-plugin/cordis.yml`。

### 独立包（M4 演进目标）

```sh
cd context-mode && pnpm build       # 需要 typescript（devDep）
npm publish                         # 需要 npm 凭据（用户侧动作）
dsh plugin add dsh-context-mode
# 或在 host composition 加行：- id: context-mode\n  name: 'dsh-context-mode'
```

> 平面决策：M4 抽包时若迁入 agent preset，知识库服务须置于 `isolate` realm 或拆为 host provider，否则 process-global 冲突会被 mount 拒绝。

## 自愈脚本（relink-dsh-context-mode.sh）

DSH 更新后（`npx` 缓存哈希会变），本插件的 `node_modules` symlink（指向 DSH 安装目录）可能失效，导致加载时报 `ERR_MODULE_NOT_FOUND`。插件自带一个自愈脚本随仓库分发：

```sh
# 用法：在插件目录下执行
chmod +x relink-dsh-context-mode.sh
./relink-dsh-context-mode.sh
```

它会：
1. 探测当前 DSH 安装位置（`PATH` 上的 `dsh` / 运行中的进程 / `~/.npm/_npx/*` 缓存）。
2. 把插件目录的 `node_modules` symlink 重指向该 DSH 安装根（`ln -sfn`）。
3. 校验 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`turndown` 是否可解析。

脚本随插件目录走（`DST` 用脚本自身所在目录推导），插件搬到任意位置都能用。DSH 升级后若插件加载异常，先跑一次本脚本——**无需重装依赖**。

> 说明：脚本只重设 `node_modules` symlink，不改 `package.json`、不碰知识库 `~/.context-mode`、不清任何数据；可放心在任一环境重复执行。

## Model Experience 段（写给模型看）

**Think in Code**：分析/统计/过滤/比较/搜索/解析/转换数据 → 用 `ctx_execute` 写程序并只打印答案（原始数据留在沙箱），不要直接把原始数据读进上下文。重内容先 `ctx_index`/`ctx_fetch_and_index` 索引、再用 `ctx_search` 取片段；`ctx_execute_file` 读文件作数据、对其跑分析 code。大输出工具（curl/wget）会被拒。批量用 `ctx_batch_execute` 或一个程序循环。返回文本要精炼到只剩结果。

## 运行环境

- DSH `v0.1.1-rc.2`、Node `>= 24`（`node:sqlite` 免编译 FTS5；type-stripping 直载 `.ts`）。
- 知识库用自有 `node:sqlite`，不经 `ctx.storageDomain`（其 backend 只有 kv facet，无 FTS）。
- 抓取用 Node 全局 `fetch`（`ctx.web` 默认无 provider）。

## 已知说明（2026-08-23 测试后修订）

- **路由强制覆盖面**：门禁用 `floodCommandWord` 逐词/逐段识别洪水工具，覆盖 `curl`/`wget` 直接调用、`sudo -u bob curl`、`env -i curl`、`/usr/bin/curl`、`./curl`、`bash -c "curl"`、重定向（`>out.txt curl`、`2>/dev/null curl`）、多命令段（`echo ok; curl`）；同时防误伤（`echo "curl"`、`grep curl`、`curl_custom` 放行）。
- **read 整读门禁（已启用）**：`maxReadBytesBeforeAsk`（默认 51200）现在是真实消费者——文本 `read` 对 `stat.size > 阈值` 的大文件 deny+引导，带 offset/limit / 信任文档 / ≤阈值 / stat 失败一律放行。与 read 自身 50KB 上限对齐（引导型省）。详见上方「read 整读门禁」节。
- **run_code 残余口（非确定性省）**：运行期无法机械拦截 `run_code` 内直接 `node:fs` 读全量并自由打印——这一路门禁看不到，属可缓解不可消除的残余口，靠指引与本文档诚实标注（非确定性省/残余口）。`run_code` 内经 read 工具的子分派仍按 size 判定（不豁免 parent）。
- **config 默认值**：bundle 机制下 loader 不应用 schemastery 默认值，插件用 `DEFAULT_CONFIG` 兜底合并；请勿依赖 loader 回填默认。
- **P0 沙箱执行（新增）**：`ctx_execute`/`ctx_execute_file`/`ctx_batch_execute` 复用 DSH `codeRuntime`（不自建沙箱）。`ctx_execute_file` 语义为「读 path 作数据 + 跑 code 分析」（非执行文件本体）。`shell` 路由默认关；`executeAllowShell=true` 才走 `ctx.shell` 且 gate 对 code 做洪水/长命令审查（S1：读 `arguments.code`）。**不承诺程序无法读/写宿主文件（B1）**。
- **P1 检索 + 记忆（新增）**：`ctx_search` 支持 `queries[]`/`sort`/`source`（老字段兼容）。会话记忆默认 opt-in 关（`memoryCapture:false`，B3）；`memoryTtlMs` 默认 7 天（非 0，B3）；捕获过滤插件合成消息 + subagent；resume 引导「先搜再问」+ 注入近期记忆。**注意**：无上游 SessionDB 的 13 类自动抽取，决策为启发式分类。
- **P2 advice/记账（新增）**：advice 结构化 routing block（`adviceStructured`/`adviceRich`，`text` 函数烘焙常量）；`ctx_stats` 展示 `kept_out_pct_measured`（仅 read 侧口径）与 `kept_out_pct_total`（含估算/下界）**并列**，勿单列 measured 当结论（S7）。
- **`codeRuntime` 可用性（未确认）**：`codeRuntime` 服务键在当前 host 注册（`ctx_doctor` 探测），但 `dsh-code-runtime-worker-thread` 是否为默认组合未验证——若未挂载，P0 的 `ctx_execute` 会 fail-open 返回「未挂载」错误（不阻塞，但功能降级）。`sessionQuery.filterEvents` host 可用（现有 restore 已验证）。
