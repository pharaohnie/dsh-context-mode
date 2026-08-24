# context-mode 对齐官方优化方案（capability-parity）

> 目标：让自研 `dsh-context-mode` 在「触发判定」与「调优参数」两条轴上对齐官方 `context-mode`（PI-agent 版），并补上官方相对自研最核心的「效果度量」与「默认安全」差距。
>
> **先决认知（影响实现取向）**：官方插件是给 **PI-agent（Claude/Codex/OpenClaw 系）** 写的，它靠 **PreToolUse `modify updatedInput` / `additionalContext`**、**PostToolUse**、**SessionStart** 等 **hook 协议**做「精确重定向改命令 + 附加上下文 + 逆向记账」。而 **DSH 宿主的 `tools/pre-execute` 前提决策只有 `allow / deny / ask` 三种，没有 `modify` / `additionalContext`**（已核实 `@deepseek-ai/dsh-tools` 的 `PreToolDecision`）。因此：
>
> - 官方那种「把 `curl url` 在运行时改写成 `echo` 并回流额外上下文」的**精确重定向，在 DSH 无法照搬**（无输入改写通道、无 pre-side 附加通道）。
> - DSH 的等价通道是：**`tools/post-execute`（`PostToolDecision.accept` 可携带 `additionalContexts`）、`tools/result`（emit 观察）** 做**逆向记账/回流**；`systemPrompt.section`/`context` 做注入；`skills.register` 做软触发。
> - 所以本方案把「触发/调优/度量」三块里**能在 DSH 落地**的做扎实，把「精确重定向」降级为「deny + 引导 + 记账」（DSH 能做的最大值），并**明确标注不可行项**，避免过度承诺。

---

## 一、差距总览（官方有而自研缺/弱）

| 维度 | 自研现状 | 官方 | DSH 可行性 |
|---|---|---|---|
| 软触发面 | 触发短语只是 `advice.ts` 静态文本里一段 | 独立 SKILL（frontmatter 30+ 短语 + `>20行` 兜底） | ✅ 用 `skills.register` 落地 |
| 硬路由覆盖 | guard + gate，覆盖 Bash/read/ctx_execute* | 8 分支（Bash/Read/Grep/WebFetch/Agent/ctx_execute*/外部MCP） | ⚠️ 可加 Grep/WebFetch 分支；Agent 子代理注入用 DSH `subagents`/`agent` 事件部分可行 |
| 安全基调 | 几乎全 fail-open，仅洪水 deny | fail-closed（`REQUIRE_SECURITY`）+ permissions.allow/deny | ✅ 用 gate allow/deny glob 落地（默认关，避免强开打扰） |
| Bash 命中 | 硬 deny 或放行（黑洞式） | 结构有界白名单 + curl/wget/构建工具精确重定向 + `bytesAvoided` 记账 | ⚠️ `modify` 不可行 → 用「白名单放行 + 其余引导/deny + 记账」降级 |
| 引导节流 | 无（deny reason 每次回传） | `guidanceOnce`（每会话每类型一次）+ `guidancePeriodic` | ✅ 内存 Set + 原子标记文件落地 |
| 搜索节流 | 仅软 budget/topN | FloodGuard 时间窗（60s/软3/硬8） | ✅ 在 `tools.ts` 内加时间窗计数 |
| 效果度量 | 字节记账，无 per-event 分类、无 latency | PostToolUse 逆向记账 → `kept_out_pct` measured + 26 类事件 + analytics | ✅ 用 `tools/result` + gate 记账分类落地 |
| 调参暴露 | config.ts schema 28 键，宿主只注入 routingEnabled，无 env | env/settings.json/CLI 运行时可调 | ✅ 加 `CONTEXT_MODE_*` env 覆盖 |

---

## 二、DSH 能力映射（哪些官方机制在此宿主下用什么替代）

| 官方机制 | DSH 替代 | 落地文件 |
|---|---|---|
| PreToolUse `modify updatedInput`（改命令） | ❌ 不可行（无输入改写）→ 保留 deny+引导 | — |
| PreToolUse `additionalContext` | ❌ pre 侧无此通道 → 用 `PostToolDecision.additionalContexts` 或 `systemPrompt.section` | `index.ts` / `advice.ts` |
| PostToolUse 逆向记账 | ✅ `tools/result`（emit 观察）或 `tools/post-execute`（attach 上下文） | `index.ts` |
| SessionStart 注入 | ✅ 已有 `agent/session-start`（restore.ts），可在此再注入 routing 块 | `restore.ts` |
| 子代理 prompt prepend | ⚠️ DSH `agents`/`subagents` 服务可查子代理；子代理 prompt 注入点待探，部分可行 | `index.ts` |
| SKILL 软触发 | ✅ `skills.register({ name, description, ... })` | `src/skill.ts` |
| permissions.allow/deny | ✅ gate 内 glob 匹配 | `gate.ts` |

---

## 三、逐项实施（文件 → 改动 → 原因）

### 3.1 修正已知 3 坑（P3-3，低风险必做）

- **`src/knowledge/tools.ts`**：`ctx_search` 的 `topN`/`budgetBytes` 参数描述写 `默认 10`/`默认 8000`，但实际默认是 `16`/`SEARCH_BUDGET_BYTES(12000)`。改描述为 `默认 16`/`默认 12000`，并让 `SEARCH_BUDGET_BYTES` 作为唯一真源（描述引常量）。
- **`src/knowledge/chunker.ts`**：注释称 `maxBytes 默认 8000 与 SEARCH_BUDGET_BYTES 一致`，但后者是 `12000`。改注释为「内部常数，与 SEARCH_BUDGET_BYTES 解耦；如需对齐请改这一处」，消除 doc/code 漂移。
- **`accountingLedger`**：`config.ts` 定义但 `index.ts` 未接线（dead config）。选择**接线上报**（`ctx_stats`/`ctx_doctor` 展示台账明细）——比删除更有价值，且与 P0-1 度量闭环天然契合。

---

### 3.2 结构性有界白名单 `isStructurallyBounded`（P1-2）

**落地**：`src/routing/gate.ts` + `src/config.ts`

**原因**：现在白名单（pwd/git status/--version/echo）只写进 `advice.ts` 文本，**代码不执行**，导致无害短命令也可能被 `bashNudgeMinCommandBytes` 长命令阈值打扰。实现一个真正执行的白名单分支：命令为白名单单命令、且无 `| ; && > <` 等 shell 控制运算符 → 直接 `next()` 放行，不进长命令 ask。

**改动**：
- `config.ts` 加 `boundedWhitelist: z.array(z.string()).default(['pwd','git','echo','ls','cat','wc','whoami'])`。
- `gate.ts` 新增 `isStructurallyBounded(command, whitelist)`：把 command 用 `floodCommandWord`/shell 分词后判断是否**单命令**且首词在白名单，且命令串无控制运算符。
- 在 bash 分支（洪水 deny 之后、长命令 ask 之前）插入：`if (isStructurallyBounded(...)) return next()`。

---

### 3.3 环境变量运行时覆盖（P3-1）

**落地**：`src/config.ts`

**原因**：官方靠 env 运行时可调；自研 config 是编译期 schema，宿主只注入 `routingEnabled:true`，其余全默认。加 `CONTEXT_MODE_*` 环境变量覆盖，让部署免改 schema 即可调。

**改动**：在 `DEFAULT_CONFIG` 计算后，加一个 `envOverride(env?)`：读取 `process.env.CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES`、`CONTEXT_MODE_MAX_READ_BYTES`、`CONTEXT_MODE_SEARCH_WINDOW_MS`、`CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER`、`CONTEXT_MODE_SEARCH_BLOCK_AFTER`、`CONTEXT_MODE_DIR`、`CONTEXT_MODE_REQUIRE_SECURITY`、`CONTEXT_MODE_DEBUG` 等，解析为数字/布尔，逐键覆盖 `DEFAULT_CONFIG`。`index.ts` 的 `apply` 收到 `rawConfig` 后再 `{...DEFAULT_CONFIG, ...envOverride(), ...rawConfig}`（优先级：显式 rawConfig > env > 默认）。

---

### 3.4 SKILL 软触发（P1-1）

**落地**：新增 `src/skill.ts` + `src/index.ts` 接线

**原因**：官方有真实 SKILL（frontmatter 30+ 触发短语，可被模型按描述软触发）。自研只把触发短语放常驻 advice 文本，激活路径弱。用 DSH `skills.register` 注册一个可软触发的 context-mode skill。

**改动**：`src/skill.ts` 定义 `registerSkill(ctx, deps)`，调用 `ctx.get('skills')?.register({ name:'context-mode', description: '...', body })`（`skills` 是可选服务，缺失静默降级）。description 复用官方那批触发短语；body 为「何时用 ctx_* 的完整指引 + 决策树」。`index.ts` 在 `registerAdvice` 后接线。

---

### 3.5 默认安全基线（P0-2）

**落地**：`src/config.ts` + `src/routing/gate.ts`

**原因**：官方有 fail-closed 安全门禁 + permissions.allow/deny。自研全 fail-open。加一层**默认关闭**的安全策略：`securityEnabled`（默认 false，避免强开打断现有流程）、`securityDenyGlobs`、`securityAllowGlobs`。

**改动**：
- `config.ts` 加 `securityEnabled: z.boolean().default(false)`、`securityDenyGlobs: z.array(z.string()).default([])`、`securityAllowGlobs: z.array(z.string()).default([])`。
- `gate.ts` 在 `routingEnabled` 检查后加一段 `applySecurityPolicy`：若 `securityEnabled` 且目标路径/命令命中 deny glob → deny；命中 allow glob → 放行；命中 deny 未 allow → deny（fail-closed 语义，仅在开启时）。glob 匹配基于 basename/前缀，简单实现（无第三方 glob，用 `*/`/`*` 通配）。

---

### 3.6 效果度量闭环（P0-1，官方最核心优势）

**落地**：`src/knowledge/sqlite.ts`（meta 分类键）+ `src/routing/gate.ts` + `src/index.ts`（`tools/result` 观察）+ `src/continuity/stats.ts`（展示）

**原因**：官方 PostToolUse 逆向记账 `bytes_avoided`/`bytes_retrieved` → `kept_out_pct` 转 measured + 事件分类（redirect/rejected-approach/latency/retrieval）。自研只有 `read_denied_bytes`/`denied_bytes`/`search_bytes` 三类，无 per-event 链、无 latency、无法回答「哪些引导最有效」。

**改动**：
- `sqlite.ts`：`incMeta` 已有；新增键语义 `redirect_bytes`（curl/wget 被改道）、`rejected_bytes`（deny 回传 rejected-approach）、`retrieval_bytes`（search_bytes 沿用 = bytes_retrieved）、`latency_events`。`computeSavedBytes` 里把 `keptOutMeasured` 改为「read 侧 + redirect/retrieval 实测」口径（可拆 `measured` 更准）。
- `gate.ts`：`recordDenied` 拆两类——洪水 deny 记 `redirect_bytes`（命中的是确定性洪水，属「改道」）+ `rejected_bytes`（reason 回传）；read deny 仍记 `read_denied_bytes`。
- `index.ts`：新增 `tools/result` 观察（或 `tools/post-execute`），对 `ctx_search` 命中片段字节记 `retrieval_bytes`、对 `ctx_execute*` 记 `execute_log_bytes`；`exec.elapsed`>5s 记 `latency_events`。
- `stats.ts`：`ctx_stats` 把三类分开展示（redirect/retrieval/latency），让 `kept_out_pct` 更接近官方 measured。

> **诚实口径**：DSH 无法像官方那样精确记录「原始文件若未被拦下会进多少字节」，但 read 侧 `stat.size` 是精确的（已按文件名去重）；curl/wget 只有命令串长度（下界）。沿用现有「measured（read 侧精确）+ total（含估算/下界）」双口径，补分类展示，不夸大。

---

### 3.7 引导节流 once/periodic（P2-2）

**落地**：新增 `src/util/guidance.ts` + `src/routing/gate.ts`

**原因**：官方 `guidanceOnce` 每会话每类型一次，防重复刷屏；`guidancePeriodic` 每 N 次重注入防 compaction 丢失。自研每次 deny 都回传 reason，可能刷屏。

**改动**：`src/util/guidance.ts` 实现 `guidanceOnce(scopeType, key)`（进程内 Map 去重 + `tmpdir/context-mode-guidance-<sid>/*.type` 原子标记，O_EXCL）与 `guidancePeriodic(counter, period)`；gate.ts 在回传 reason 前判断「是否首次/该周期」，非首次则折叠为简短 reason 或静默，避免刷屏。

---

## 四、优先级与实施顺序

**P0（高价值/官方核心缺口，先做）**
1. 修正 3 坑（§3.1）—— 低风险，先落地
2. 效果度量闭环（§3.6）—— 官方最核心优势
3. 结构性有界白名单（§3.2）—— 直接改善触发体验

**P1（增强）**
4. SKILL 软触发（§3.4）
5. 默认安全基线（§3.5，默认关）

**P2（顺手/对齐）**
6. env 运行时覆盖（§3.3）
7. 引导节流（§3.7）

---

## 五、已知不可行项（避免过度承诺）

- **精确重定向改命令（`modify updatedInput`）**：DSH 前提决策无 `modify`，无法在运行时改写命令 + 回流额外上下文。降级为 deny + 引导 + 记账。
- **permissions.allow/deny 按文件路径的完整安全策略**：DSH 有 `sandboxPolicy`，但本插件的 gate 只能做 basename/前缀 glob 匹配，做不到官方 settings.json 那种完整文件级语义。已用 §3.5 近似对齐。
- **analytics 成本聚合**：DSH 无 per-token 价格计价层（需 `llm` adapter 配合），$ 成本聚合不可行；仅保留字节/token 估算与 per-event 分类度量。

---

## 六、验证

1. `ctx_doctor` 全 ✓。
2. 场景 A：无害短命令（`pwd`/`git status`）→ 直接放行，不触发长命令 ask。
3. 场景 B：`curl url` → deny + 引导（refined reason），`ctx_stats` 的 redirect_bytes 增加。
4. 场景 C：`ctx_search` 命中片段 → `retrieval_bytes` 增加，`ctx_stats` 展示分类。
5. 场景 D：`securityEnabled=false`（默认）→ 行为与现状完全一致（不回归）；`true` + denyGlob → 命中 deny。
6. 场景 E：设置 `CONTEXT_MODE_MAX_READ_BYTES=30000` → env 覆盖生效。
7. 场景 F：`ctx_doctor`/`ctx_stats` 正确反映新配置与度量，且不变更既有记账口径可读性。
