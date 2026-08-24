# context-mode 合规修复计划（三处不合规）

- 配套文档：[COMPLIANCE_REPORT.md](./COMPLIANCE_REPORT.md)（问题 #1/#2/#3）
- 基线：git `22bc245`，工作树干净
- 原则：**每处修改独立 commit，可单独回滚；每步带验证；知识库数据（`~/.context-mode/content`）全程不动**
- 已核实事实：`@deepseek-ai/dsh-tools` 已发布公共 npm（latest `0.0.1-rc.1`，next `0.1.1-rc.2`，宿主 DSH 即 0.1.1-rc.2）；`@deepseek-ai/schemastery` 3.18.1 已在 profile node_modules

---

## 修改一（高）：入口导出 Config schema

**文件**：`src/index.ts`

**改动**：
1. 第 3 行 import 中 `Config` 改为独立 re-export：
   ```ts
   import { DEFAULT_CONFIG, envConfigOverrides, type ContextModeConfig } from './config.ts'
   export { Config } from './config.ts'
   ```
2. `pnpm build` 同步 dist。

**两步走（关键：先观测，再定合并逻辑）**：

- **步骤 1a**：仅加导出，重启 DSH，用临时日志观测 loader 传给 apply 的 `rawConfig`——
  `console.log('[context-mode] rawConfig keys:', Object.keys(rawConfig ?? {}).length)`，
  判定 loader 是否应用了 schema 默认值（rawConfig 是完整对象还是稀疏对象）。
- **步骤 1b（按观测结果分支）**：
  - **若 rawConfig 稀疏**（loader 不填充默认，印证作者实测）→ 现有合并逻辑不动；更新 config.ts:110 注释，把「环境事实」补记为「已导出 Config 后复测仍不填充」。
  - **若 rawConfig 完整**（导出后 loader 开始填充）→ 现有三段合并 `{...DEFAULT, ...env, ...rawConfig}` 中 env 覆盖会被 rawConfig 内的填充默认值压掉而失效。将 env 覆盖改为「仅覆盖值等于 DEFAULT_CONFIG 同名键的项（视为用户未显式配置）」，约 8 行实现，保持 CONTEXT_MODE_* 调参通道有效。

**验证**：
- 重启后无 schema 校验错误（`maxReadDenyBytes` 无 default 字段已被 `DEFAULT_CONFIG` 推导证明 validate 通过）；
- `ctx_doctor` 全部 ✓；观测完成后移除临时日志。

**风险与边界**：
- patch 行仍不带 `config`（不触碰 dshmarket parseSimplePatch 纯 insert 约束）；
- 若未来用户在 patch 行写 config，导出后才享有官方校验与默认值填充。

---

## 修改二（高）：SQLite 连接生命周期挂钩

**文件**：`src/index.ts`

**改动**：
1. apply 的窄化 ctx 参数类型增加 effect 签名：
   ```ts
   effect(fn: () => () => void): unknown
   ```
2. `openKnowledgeDb` 成功分支之后注册清理：
   ```ts
   if (kdb) {
     ctx.effect(() => () => { try { kdb.db.close() } catch { /* 已关闭 */ } })
   }
   ```
3. `pnpm build` 同步 dist。

**验证**：
- 重启 DSH → `ctx_doctor` ✓，`ctx_search` 一次（功能不回归）；
- 卸载路径测试：临时在 profile patch 的插件行加 `config:` 触发 HMR 卸载/重载 → 无 `database is not open` 报错 → 撤销临时 config；
- WAL 行为：正常 close 会 checkpoint，`ls ~/.context-mode/content/` 观察 `content.db-wal` 不再无限增长。

**风险与兜底**：
- 多次 close 抛错已 try-catch；HMR 期间旧连接关闭与新 apply 重开之间的窗口由 `busy_timeout=5000` 兜底。

---

## 修改三（中）：安装机制三层

### 3a. workspace + patch insert（不进 bundles）：维持现状 + 小加固

**决策：不改机制**。dshmarket 两个缺陷（安装/卸载其他插件时重写 package.json 丢失 bundles 登记；bundle 层与 patch 层同 id 触发 `duplicate loader entry id` 拒绝启动）未修复前，官方 `dsh plugin add` + bundles 通路不可用；README 已记录动因。

**加固动作**：删除 profile `cordis.patch.yml` 中冗余的两行（`- id: context-mode / disabled: false`——insert 已生效，disabled 默认即 false）。

**迁移条件（补进 README 故障排查节）**：dshmarket 修复上述两缺陷后 → 删 profile patch 的 insert 行 → `dsh plugin --profile web add ~/.dsh/plugins/dsh-context-mode` 正规登记 bundles。

### 3b. peerDeps 解析去 symlink hack：【已决策：做实验（方案 A），失败即回退方案 B】

**方案 A（执行，约 10 分钟）**：
1. 插件 `package.json` peerDependencies 中 `"@deepseek-ai/dsh-tools": "*"` pin 为 `"^0.1.1-rc.2"`（对齐宿主版本，避免 `*` 解析到旧 latest 0.0.1-rc.1）；
2. profile `pnpm-workspace.yaml`：`autoInstallPeers: false` → `true`；
3. profile 下 `pnpm install`（应装出 `profile/node_modules/@deepseek-ai/dsh-tools`）；
4. **删除插件目录的 node_modules symlink**（关键实验点：Node 对 workspace symlink 的 realpath 解析行为决定成败——若 loader 从 symlink 逻辑路径解析则 A 成立，若 realpath 到插件目录则 A 失败）；
5. 重启 DSH 验证。

**注意**：`autoInstallPeers: true` 影响所有 workspace 包（`my-custom-inject` 同步受益），需一并回归其加载日志。

**方案 B（A 失败即回退，零损失）**：恢复 symlink（`./relink-dsh-context-mode.sh` 一条命令）；把「跑 relink 脚本」从故障排查提升为 README 安装第 7.5 步；可选在 `ctx_doctor` 增加 node_modules symlink 健康检查项。

**验证**：重启无 `ERR_MODULE_NOT_FOUND`；`ctx_doctor` ✓；任一 `ctx_*` 工具调用成功。

### 3c. main 指向 TS 源码 + dist 冗余：【已决策：方案 A - 自用导向】

**执行内容**：
1. `package.json`：main 保持 `./src/index.ts` 不动；`files` 移除 `dist`；删除 `scripts.build` 与 `devDependencies.typescript`（tsc 仅服务 dist 构建，无其他消费者；`tsconfig.json` 保留供编辑器/smoke 类型检查用）。
2. 删除 `dist/` 目录（git rm -r）。
3. README「运行环境」节补注：入口为 TS 源码、依赖 DSH/Node type-stripping（Node ≥ 24）；dist 已移除，发布前按官方规范补 `prepare` 脚本并切 main 至构建产物（动作清单见本节原方案 B 列）。

**注意**：修改一/修改二原计划中的「`pnpm build` 同步 dist」步骤随本决策**取消**（dist 不复存在，src 即唯一事实源）。

| 对照 | 方案 A：自用导向（已选） | 方案 B：发布导向（未选，留档） |
|---|---|---|
| main | 保持 `./src/index.ts`（type-stripping，git c79688a 既有决策） | 切 `./dist/index.js` |
| dist | **删除** dist/、build script，files 去掉 dist（消除双份漂移源） | 保留并成为唯一入口 |
| prepare | 无（不分发） | 加 `"prepare": "tsc -p tsconfig.json"`（官方对 git 分发的要求） |
| 代价 | 无 type-stripping 环境不可用（当前不发布，无实际影响） | 开发迭代多一步 build；HMR 热更目标变为 dist |
| 适用 | 现状：未发布（22bc245 已删「作为发布包」章节） | 近期要发 npm / 供他人 git 安装 |

---

## 实施顺序

1. **3c 方案 A**（先行：删 dist 与构建脚本--后续步骤随之免去 `pnpm build` 同步负担，src 成为唯一事实源）
2. **修改二**（最小、无依赖、独立成立，立刻消除一处高优先级违规）
3. **修改一 1a**（导出 + 观测）→ **1b**（按观测结果决定是否调合并逻辑）
4. **3a 加固**（profile patch 清理，一次编辑）
5. **3b 方案 A 实验** → 成败决定走 A（收尾：删 relink 脚本或降级为备用工具）或 B（恢复 symlink + README/doctor 加固）
6. 全量回归 + 更新 README（安装章节、运行环境说明）+ 报告复查

## 回归清单（每步之后执行）

- `node scripts/smoke.ts`（纯逻辑回归：FloodGuard 分桶 / chunkStats / advice 构建 / SSRF 防护 / FTS5 转义 / read 门禁）
- 重启 DSH：`ctx_doctor` 全 ✓；`ctx_search`、`ctx_execute`、`ctx_stats` 各调用一次
- dshmarket 状态：`curl http://127.0.0.1:3080/dsh-market/installed` 中 dsh-context-mode 为 `live True`
- `my-custom-inject` 加载日志正常（3b 牵连方）

## 提交与回滚

- 每处修改独立 commit：`fix(compliance): export Config schema`、`fix(compliance): close knowledge db on dispose`、`chore(compliance): pin peer dep & drop symlink hack` 等；`COMPLIANCE_REPORT.md` 与本计划一并入库
- 任一步失败：`git revert` 对应单 commit；3b 实验失败直接 `./relink-dsh-context-mode.sh` 即回滚
- profile 侧改动（pnpm-workspace.yaml、cordis.patch.yml）不在插件 git 内，改动前以 `.bak` 后缀留副本（该目录已有此惯例）

## 决策记录（2026-08-24 已定）

1. **3c**：方案 A - 自用导向（main 保持 src，删除 dist 与构建脚本）。
2. **3b**：本轮执行方案 A 实验（pin peer + autoInstallPeers + 删 symlink 验证），失败回退方案 B（relink 保底 + 文档/doctor 加固）。
