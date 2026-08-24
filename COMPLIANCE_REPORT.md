# context-mode 插件 DSH 注册合规性审查报告

- 审查日期：2026-08-24
- 审查对象：`~/.dsh/plugins/dsh-context-mode`（git@22bc245），及其在 profile `~/.dsh/profiles/web/` 中的挂载方式
- 规范来源：DeepSeek Harness 官方文档树（deepseek-harness.github.io），辅以本机 DSH v0.1.1-rc.2 安装产物的类型声明做事实核对
- 方法：逐项对照「第一个插件 / 插件配置 / 打包与安装 / 开发一个工具 / 插件与生命周期 / 事件系统 / tools·system-prompt·skills 子系统」页面的规定，与插件源码、profile 组合文件、DSH 安装产物三方互证

---

## 一、结论摘要

插件的 **Cordis 运行时注册面（事件、工具、guard、section、skill、inject）与官方 API 高度对齐，事件名与类型形状全部属实**；不合规集中在 **配置注册（Config schema 未从入口导出）、副作用清理（SQLite 连接无 ctx.effect）、安装/组合机制（绕过 dsh plugin add 与 dsh.profile.bundles 的三层 workaround）** 三处。按严重度分级如下。

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| 1 | 高 | 入口未导出 Config schema，配置体系脱离 Cordis 校验/默认值机制 | `src/index.ts` |
| 2 | 高 | 打开的 SQLite 知识库无任何清理挂钩（全 src 零 `ctx.effect`） | `src/index.ts` / `knowledge/sqlite.ts` |
| 3 | 中 | 绕过官方安装机制：workspace:\* + 手动 pnpm-workspace 登记 + profile patch 手动 insert，不进 `dsh.profile.bundles` | profile 目录 + `cordis.patch.yml` |
| 4 | 中 | peerDependencies 解析依赖插件目录内 node_modules symlink（指向 npx 缓存），非官方机制 | `relink-dsh-context-mode.sh` |
| 5 | 中 | `main` 指向 TS 源码而非构建产物，`dist/` 成为无人引用的冗余副本 | `package.json` |
| 6 | 低 | 部分 async 工具 execute 未接收/转发 `exec.signal` | `knowledge/tools.ts` |
| 7 | 低 | 事件监听用 `as never` 断言绕过官方类型安全（declare module）机制 | gate/restore/memory |
| 8 | 低 | systemPrompt section `order: 30` 不符合 tool guidance 100–199 约定 | `routing/advice.ts` |
| 9 | 低 | 模块级跨 apply 状态（HMR 语义偏差） | `index.ts` / `restore.ts` |
| 10 | 备注 | profile patch 中 `disabled: false` 冗余行（无害） | profile `cordis.patch.yml` |

---

## 二、已验证合规项（避免误报）

以下各项逐一经官方文档与本机 DSH 类型声明（`@deepseek-ai/dsh-tools`、`dsh-agent`、`dsh-skill` 的 `.d.ts`）双重核实：

1. **插件导出形态**：`export const name` + `export const inject` + `export function apply(ctx, config)`，符合官方「第一个插件」「开发一个工具」页的插件三要素。
2. **依赖注入姿势**：硬依赖 `inject: ['tools', 'systemPrompt']` 声明后访问；可选服务（sessionQuery/tokenMeter/sessions/approval/codeRuntime/fs/shell/sandboxPolicy/skills）一律 `ctx.get()` 并容错降级——符合官方「服务与依赖」约定。
3. **事件名全部真实存在**（这是本次审查最核心的运行时注册面）：
   - `tools/pre-execute`：官方 waterfall 事件，`dsh-tools/lib/types/index.d.ts:38`；
   - `agent/session-start`、`agent/inbox/inserted`、`agent/turn-stopping`：`dsh-agent/lib/types/runtime-types.d.ts:220/180/301`。
4. **waterfall 契约**：gate.ts 放行必 `return next()`、短路返回 `{kind:'deny',reason}` / `{kind:'ask',reason}`，与官方 `PreToolDecision`（allow/deny/ask 三态）完全一致；门禁异常 fail-open 走 `next()`。
5. **ToolGuard 契约**：guard.ts 同步签名 `(exec) => string | undefined` 与官方 `ToolGuard` 类型一致；`ctx.tools.guard()` 为官方 API（`d.ts:622`）。
6. **systemPrompt.section**：`{name, order, text}` 符合官方 `PromptSection` 接口。
7. **skills.register**：传入 `{name, description, whenToUse, content, source:'runtime', invocation, provider}` 符合官方 `SkillRegistration`（`Omit<SkillDefinition,'invocation'|'provider'>` 扩展）；返回的 disposer 由 Cordis fiber 自动追踪。
8. **Agent.inject**：`agent.inject(message)` 为官方 API（`runtime-types.d.ts:132`），注入消息带 `source: {kind:'plugin'}` 标注。
9. **defineTool 用法**：`parameters` / `output.schema` / `output.render` / `execute(args, exec)` 形状符合官方 ToolDefinition。
10. **bundle manifest 结构**：`package.json` 的 `dsh.bundle.patch -> cordis.patch.yml`、patch 纯 insert 行按包名引用（`name: 'dsh-context-mode'`），符合官方「打包与安装」页的组合包形态。
11. **既往已修复**：git fb6a985 已移除非官方 manifest `dsh.plugin.json`（DSH 不读取）；f8f24a7 已将 patch 保持纯 insert 以兼容 dshmarket 热挂载。

---

## 三、不合规与偏离项详述

### 1.【高】入口未导出 Config schema

- **官方规定**（插件配置页）：「在插件中导出一个 Config 类型和同名的 Schemastery schema；默认值直接写在 schema 中」「插件加载时，Cordis 会通过导出的 schema 校验配置，并填充未提供字段的默认值」「不要导出普通对象作为 Config」「配置错误要响亮（使无效配置在插件加载时失败）」。
- **实际做法**：`src/config.ts` 中定义了完全合规的 Schemastery `Config`（含全部默认值），但入口 `src/index.ts` 只 `import { Config, ... }` **未 re-export**。apply() 内改为手动三段合并（`DEFAULT_CONFIG` + `envConfigOverrides()` + `rawConfig`）兜底。
- **后果**：
  - 用户在 patch 行写 `config:` 得不到 schema 校验与默认值填充；
  - 无效配置不会在加载时失败（违反「响亮」原则）；
  - 官方「配置变更触发 HMR + schema 校验」的通路整体空转。
- **关键疑点**：config.ts:110 注释称「本插件实测 bundle 机制 loader 不应用 schemastery 默认值（环境事实）」。但该实测很可能正是在 **Config 未导出** 的状态下做的——loader 只有拿到导出的 schema 才有东西可应用。根因与现象可能同源，建议先补导出再复测（见第五节建议 1）。

### 2.【高】SQLite 知识库连接无清理

- **官方规定**（第一个插件页 / 插件与生命周期页）：「通过 ctx 注册的任何东西……都会被自动清理。如果你有需要手动清理的资源（比如一个网络连接），用 ctx.effect() 告诉框架怎么清理」；自动清理仅覆盖 `ctx.on` / `ctx.tools.register` / `ctx.llm.registerAdapter` / `ctx.effect` 四类。
- **实际做法**：apply() 中 `openKnowledgeDb()` 打开 `DatabaseSync`（WAL 模式 + busy_timeout），此后 **全 src 没有任何一处 `ctx.effect`**，也没有把 `db.close()` 挂到任何清理路径（唯一一处 `.close()` 是 doctor.ts 里 `:memory:` 临时库的即用即关）。
- **后果**：插件禁用/HMR/热替换时数据库连接不关闭，WAL/SHM 伴生文件残留；违反官方「每个副作用必须可逆」。当前该插件恒启用（`disabled: false`），实际暴露面有限，但这是官方规范中白纸黑字的要求，且修复成本极低。
- **对照**：其余注册（guard/section/tools.register/on/skills.register）返回的 disposer 均被 fiber 自动追踪，唯独 DB 是例外。

### 3.【中】绕过官方安装机制（三层 workaround）

- **官方规定**（打包与安装页）：组合包通过 `dsh plugin --profile <name> add <pkg>` 安装——pnpm 链接 + 把包**追加进 `dsh.profile.bundles`**；生效配置按「bundles 列表各层 → profile patch → home patch → --patch overlay」顺序组合。
- **实际做法**（README 第 4–6 步自述为「写给 agent 的逐步指令」）：
  1. 手动把插件绝对路径写进 profile 的 `pnpm-workspace.yaml` `packages`；
  2. profile `package.json` dependencies 手写 `"dsh-context-mode": "workspace:*"`；
  3. profile `cordis.patch.yml` 手动 insert 插件行，**bundles 列表中明确不放**（README：同时存在会触发 `duplicate loader entry id: context-mode`，cordis 拒绝启动）。
- **定性**：这是对 dshmarket 两个实际缺陷（安装/卸载其他插件时重写 package.json 丢失 bundles 登记；与 bundle 层 insert 行 id 冲突）的**有记录的 workaround**，不是无意错误。但它使官方 bundle 层的加载顺序语义、`dsh plugin remove` 联动卸载、dshmarket 的组合包管理全部旁路——按官方规范衡量属机制性偏离。
- **附注**：profile patch 中 `- id: context-mode / disabled: false` 一行冗余（insert 已生效，disabled 默认即 false），无害但建议清理。

### 4.【中】peerDependencies 解析依赖非官方 symlink

- **官方模型**（打包与安装页）：profile 的 pnpm 管理树外组合包；「内置组合包名称始终从 dsh 安装目录本身解析；pnpm 只管理树外的包」。
- **实际做法**：profile `node_modules/@deepseek-ai/` 下**没有 dsh-tools**（且 `autoInstallPeers: false`）；插件 `import '@deepseek-ai/dsh-tools'` 实际靠**插件目录自身的 node_modules symlink**（指向 `~/.npm/_npx/<hash>/node_modules`，由 `relink-dsh-context-mode.sh` 维护）解析。
- **后果**：DSH 经 npx 更新（哈希目录变化）即断链报 `ERR_MODULE_NOT_FOUND`，需手动跑 relink 脚本自愈（README 故障排查表自认）。属非官方、脆弱的解析路径。

### 5.【中】入口指向 TS 源码，dist 冗余

- **官方规定**（打包与安装页）：组合包示例 `main: "index.js"`（构建产物）；并明确「git 安装拉取的是源码……TypeScript 包到手时没有 lib/ 输出，加载会失败」，作者须提供 prepare 脚本构建出**发布入口**。
- **实际做法**：`main: "./src/index.ts"`（git c79688a 有意为之），依赖 DSH/Node 的 type-stripping 直接加载 .ts；`dist/` 由 tsc 构建且 `files` 中随包分发，但**没有任何消费者**（当前 dist/index.js 比 src/index.ts 晚 5 分钟，靠手动 build 同步）。
- **后果**：本机 DSH v0.1.1-rc.2 下运行无碍；但按官方分发规范，进入不含 type-stripping 的环境（或他人按官方方式 git/npm 安装）时入口语义不符合预期，且 src/dist 双份代码存在漂移风险。

### 6.【低】部分 async execute 未接收 exec.signal

- **官方规定**（tools 子系统页 ToolDefinition.execute JSDoc）：「Async work must observe or forward `exec.signal` and settle only after its owned work reaches quiescence」。
- **实际做法**：`ctx_fetch_and_index`（网络抓取，最应响应取消）与 `ctx_purge` 的 `execute` 签名未声明 `exec` 参数，自然也未转发 signal；其余工具（ctx_index/ctx_search/ctx_execute 系）接收了 `exec` 但多未消费 signal。

### 7.【低】事件监听用 `as never` 绕过类型安全

- **官方规定**（事件系统页）：用 `declare module '@deepseek-ai/cordis'` 声明合并获得事件类型安全。
- **实际做法**：`ctx.on('tools/pre-execute' as never, ...)` 等 4 处断言。事件名碰巧全部正确（本次已核实），但拼写错误将无法被编译器发现，官方类型安全机制被放弃。

### 8.【低】advice section order 不符约定

- **官方规定**（system-prompt 子系统页 PromptSection.order 注释）：「Convention: -100 is the harness identity, 0 the deployment persona, **tool guidance uses 100–199**」。
- **实际做法**：`order: 30`。该 section 内容即 tool guidance（何时用 ctx_*），按约定应落在 100–199 区间。功能不受影响，仅排序约定偏差。

### 9.【低】模块级跨 apply 状态

- **官方语义**（插件与生命周期页）：HMR 卸载旧实例后「不会保留旧实例的注册」——该保证只覆盖 effect 追踪的注册，不含模块级可变状态。
- **实际做法**：`index.ts` 的 `deniedReadFiles`（Set，按 file_path 去重）、`restore.ts` 的 `restoredFingerprints`（Map，有 FINGERPRINT_CAP）为模块级，HMR 后残留于新实例。均有界、有明确设计注释（去重语义），实际风险很小。（flood-guard 经核实为 apply 内闭包实例，随 fiber 生命周期，不在此列。）

---

## 四、依据文档

- 第一个插件：https://deepseek-harness.github.io/deepseek-harness/develop/basic/ （ctx.effect、自动清理、inject、cordis.yml 插件行）
- 插件配置：https://deepseek-harness.github.io/deepseek-harness/develop/basic/config （Config schema 导出与校验、响亮失败、HMR）
- 打包与安装：https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish （dsh.bundle、dsh plugin add、bundles 加载顺序、prepare/构建产物入口）
- 开发一个工具：https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool （defineTool 形态）
- 插件与生命周期：https://deepseek-harness.github.io/deepseek-harness/develop/framework/ （Fiber 状态机、自动清理范围、HMR）
- 事件系统：https://deepseek-harness.github.io/deepseek-harness/develop/framework/events （waterfall/next()、声明合并、监听器即效果）
- tools 子系统：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools （ToolDefinition.execute 的 signal 契约）
- system-prompt 子系统：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/system-prompt （PromptSection.order 约定）
- skills 子系统：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills （SkillProvider/register 语义）
- 事实核对源（非规范，仅验证 API 真实性）：本机 `@deepseek-ai/dsh-tools`、`dsh-agent`、`dsh-skill` 安装产物 `.d.ts`；`dshmarket` 行为取自 README 实测记录。

## 五、修复建议（按性价比排序）

1. **补导出 Config（一行）**：`src/index.ts` 增加 `export { Config } from './config.ts'`，随后复测「loader 是否应用默认值」——若实测结论翻转，可同时简化 DEFAULT_CONFIG 兜底注释；若不翻转，则该环境事实成立且已有兜底，无损失。
2. **注册 DB 清理（三行）**：apply 内 `ctx.effect(() => () => { try { kdb?.db.close() } catch {} })`，满足官方可逆性要求。
3. **fetch/purge 工具补 exec 参数并转发 signal**（对齐官方 execute 契约，网络抓取可被取消）。
4. **事件断言改声明合并**（`declare module` 扩展 Events 接口），获得编译期事件名校验。
5. **advice section order 调整到 100–199**（如 110），对齐官方排序约定。
6. **机制类（问题 3/4/5）**：属架构性取舍，不建议立即回改——workspace 方案是对 dshmarket 两个实际缺陷的合理防御；待 dshmarket 修复 duplicate id / bundles 重写问题后，再回归官方 `dsh plugin add` + bundles 机制，并届时把入口切到 dist（或去掉 dist）。短期可先在 package.json 补 `prepare` 脚本（官方对 git 分发的要求），使两种入口策略都成立。

## 六、范围外与未确认项

- dshmarket 的 `parseSimplePatch` 只接受纯 insert 的行为、以及「重写 package.json 丢失 bundles 登记」——均来自 README 实测记录，官方文档树未覆盖 dshmarket 内部行为，本报告未将其计为规范结论。
- 「loader 对 bundle 行不应用 schema 默认值」是否在导出 Config 后仍然成立，需按建议 1 复测后方可定论；本报告仅指出根因存疑。
