# 修正计划：codeRuntime 沙箱契约引导缺失（require is not defined）

> 2026-08-25 · 依据当日诊断（ctx_execute_file 对 /tmp/ctx-scan-5069/session.jsonl 统计时报
> `ReferenceError: require is not defined`）

## 1. 背景与根因

**现象**：模型在 `ctx_execute_file` 的 code 里写 `const fs = require("node:fs"); fs.readFileSync(FILE_SRC, ...)`，
codeRuntime 抛 `ReferenceError: require is not defined`，任务失败。

**根因链（三层）**：

1. **宿主沙箱机制**（不可改，属设计而非 bug）：`dsh-code-runtime-worker-thread` 把程序体包进
   `new AsyncFunction(...namespaces, "console", "'use strict';\n" + code)(...)` 执行——程序是
   严格模式异步函数体，作用域内只有调用方 bindings + console shim；宿主侧 `stripTypeScriptTypes()`
   只剥类型不做模块解析。**CommonJS `require` 与 ESM 静态 `import` 均不存在**。
2. **插件调用姿态**（既有设计，维持）：`runSandbox` 以 `bindings: []` 调 `codeRuntime.run`
   （B1 安全图景：默认不注入 fs binding）。沙箱内无文件系统访问。
3. **模型代码违反 FILE_SRC 契约**：`ctx_execute_file` 已把文件完整内容以字符串注入 `FILE_SRC`
   （execute.ts:128 `const FILE_SRC = (${JSON.stringify(src)})`）——它是**内容不是路径**，
   code 里不应也不需要再读文件。

**插件侧真正的缺陷**：工具参数描述、system prompt 引导（advice.ts）、skill/README 文本三处
都未传达上述契约；错误回传文本（`context-mode: codeRuntime 失败 [exception] ...`）也无自愈指引。
模型只能踩坑失败，且看到报错后仍不知道怎么改。

## 2. 目标与非目标

**目标**：
- G1（调用前防错）：模型写 code 前就知道能力边界——无 require/import、FILE_SRC 是内容字符串。
- G2（失败后自愈）：错误回传尾部附带改写指引，模型一步重试即可成功。
- G3（口径一致）：工具 schema / system prompt / skill / README 四处契约表述一致。

**非目标**：
- ❌ 不给沙箱注入 require polyfill 或 fs binding——违背 B1 安全图景（"不承诺程序无法读写宿主文件，
  减小攻击面"），且宿主包在 npx 缓存中不可改。
- ❌ 不修改 `@deepseek-ai/dsh-code-runtime*`（DSH 官方包）。
- ❌ 不做通用错误解析——只匹配已知模块系统错误模式，其余错误原样返回。

## 3. 改动项

### A1 工具参数描述补契约（`src/knowledge/execute.ts`）— P0

- `ctx_execute.code`、`ctx_batch_execute.commands` 的 description 增补一句：
  > 程序体=async function body：顶层 await/return 可用；**无 require/import（无模块系统）**，可用标准 JS 内置 + console.log；需要文件系统/命令行请用 language:"shell" 或原生 bash 工具
- `ctx_execute_file.code` 的 description 额外强调：
  > FILE_SRC 已是该文件**完整内容（string）**，直接对其处理，不要再读文件、不要把它当路径
- 约束：每处增量 ≤ 2 行，控制 schema token 成本。

### A2 错误回传自愈指引（`src/knowledge/execute.ts`）— P0

- 新增**纯函数**（导出，供 smoke 直测）：

  ```ts
  /** 命中已知"沙箱无模块系统"错误时返回改写指引，否则返回空串。 */
  export function sandboxErrorHint(message: string): string
  ```

  匹配模式（大小写不敏感）：
  `/require is not defined|module is not defined|cannot use import statement|import is not defined/`
- 指引文本（追加在错误 text 尾部，一次、不重复）：
  > 提示：沙箱无模块系统（require/import 均不可用）。直接使用已注入的变量（如 FILE_SRC，已是文件完整内容字符串）与标准 JS 内置；需要文件系统或命令行请改用 language:"shell" 或原生 bash 工具。
- 接入点：`runSandbox` 组装 `context-mode: codeRuntime 失败 [...]` 处拼接 hint。

### A3 system prompt 引导同步（`src/routing/advice.ts`）— P0

- `buildStructured`：在 `## ctx_execute vs run_code` 节前新增小节 `## 沙箱契约（ctx_execute*）`：
  > - code 是 async function body：顶层 await/return 可用；**无 require/import/模块系统、无 fs**（需要文件系统/命令行 -> language:"shell" 或 bash 工具）
  > - ctx_execute_file 的 FILE_SRC 是文件**完整内容（string）**，不要再读文件、不要当路径
- `buildLean`：同步一行精简版（"ctx_execute* code 无 require/import；FILE_SRC=文件内容字符串，勿再读文件；要 fs/命令行用 shell 路由"）。

### A4 skill 与 README 同步 — P1

- `skills/context-mode/SKILL.md`：工具表 `ctx_execute_file` 行补"FILE_SRC=完整内容字符串"；补一行沙箱契约。
- `README.md`：ctx_execute / ctx_execute_file 用法段补契约说明 + 一个正/反例（反例即本次 require 用例）。

### A5 smoke 用例（`scripts/smoke.ts`）— P0

- `sandboxErrorHint`：正例（四种错误消息各命中）、负例（普通 ReferenceError / undefined 不命中）、
  传入空串安全。
- advice 断言：`buildStructured` / `buildLean` 输出包含 `require`（契约关键词）与 `FILE_SRC`。

## 4. 验证方案

1. **纯逻辑回归**：`node scripts/smoke.ts` 全绿（既有 254 行用例 + 新增用例）。
2. **真机正例**（DSH 会话内）：用修正后的代码（直接 `FILE_SRC.split("\n")`，去掉 require/fs）重跑
   `/tmp/ctx-scan-5069/session.jsonl` 统计——即原始失败用例，应产出 ground-truth 结果。
3. **真机负例**：故意提交含 `require("node:fs")` 的 code，确认错误 text 尾部带 A2 指引（一步自愈路径成立）。
4. **引导长度检查**：advice 注入文本增量 ≤ 3 行。

## 5. 实施顺序

| 批次 | 内容 | 说明 |
|---|---|---|
| 1 | A1 + A2 + A3 + A5 | 一次提交（防错 + 自愈 + 引导 + 测试，核心闭环） |
| 2 | A4 | 文档/skill 跟进 |
| 3 | 验证方案 2/3 | 真机验证并记录结果 |

预计总量：约 +40 行源码 / +30 行测试，半小时内完成。

## 6. 风险与回退

| 风险 | 评估 | 缓解 |
|---|---|---|
| 描述变长增加工具 schema token | 低（每处 ≤ 2 行） | 措辞压缩， lean 模式只加一行 |
| 字符串匹配误伤（如恰好有自定义变量叫 require 的报错） | 代价低：hint 只是追加提示，不吞错误、不改变错误语义 | 仅在 `codeRuntime 失败 [exception]` 分支追加 |
| 与宿主未来版本契约漂移（宿主将来支持 import） | 低 | hint 措辞中性；A1/A3 文本集中在少数几处，好改 |
| 回退 | 单 commit revert | — |

## 7. 不改动的部分（明确记录）

- `runSandbox` 的 `bindings: []` 调用姿态（B1 安全图景，维持）。
- 宿主 `dsh-code-runtime` / `dsh-code-runtime-worker-thread` 包。
- `ctx_execute_file` 默认 code、`maxSourceBytes` 上限逻辑（B-06）。
