# dsh-context-mode

给 DeepSeek Harness（DSH）的上下文窗口减负：重内容索引进知识库、用检索片段替代整文件进上下文；洪水工具（curl/wget/超长 read）拦下改道；计算丢进沙箱只回答案。

## 安装

### 作为 profile 插件（本地 link 形态）
在 DSH profile 的 `package.json` 里：

1. `dependencies` 加 `"dsh-context-mode": "link:/绝对路径/到/插件目录"`（或 `../` 相对路径）。
2. `dsh.profile.bundles` 数组加 `"dsh-context-mode"`。
3. 在 profile 目录跑：
   ```sh
   pnpm install
   ```
4. 重启 DSH。用 `ctx_doctor` 自检（`codeRuntime`/知识库/门禁 armed 均应 ✓）。

### 作为发布包
`dsh plugin add dsh-context-mode`（或在 profile `dependencies` 加包名），并在 `dsh.profile.bundles` 登记后重启。

> **依赖自愈**：DSH 经 `npx` 更新后，插件 `node_modules` 若指向旧 npx 缓存会报 `ERR_MODULE_NOT_FOUND`。跑一次插件目录的 `./relink-dsh-context-mode.sh`（或重新 `pnpm install`）即可——脚本只重设该 symlink，不动配置/数据。

## 原理

只做三件事，核心是"让越少原始字节进上下文越好"：

1. **索引 + 检索（知识库）**：`ctx_index`/`ctx_fetch_and_index` 把文件/网页切小块（FTS5：porter 词根 + trigram 子串 + RRF 合并）入库；`ctx_search` 只返回命中片段，而非整文件（支持 `queries[]` 批量、`sort`/`source` 过滤）。
2. **路由拦截（`tools/pre-execute`）**：把确定性洪水硬拦并给引导——curl/wget/inline-fetch、超长 `read`、无界 bash 长命令；而带 `offset/limit` 的精确读、信任文档（README/package.json 等）放行。被拒 reason 直接告诉模型改用检索/沙箱。
3. **沙箱执行（Think-in-Code）**：`ctx_execute`/`ctx_execute_file`/`ctx_batch_execute` 复用 DSH `codeRuntime`，让模型写段程序处理数据、只把 `console.log`/返回值得回上下文，原始数据留在沙箱。`ctx_execute_file` 读文件内容作数据、对其跑分析代码（非执行文件本体）。

另附 `ctx_stats`（节约台账）、`ctx_doctor`（诊断）；可选 `memoryCapture` 捕获会话决策/约束（默认关，隐私考虑）。

## 效果

- **省 token**：把「整文件 / 大输出」换成「命中片段 / 程序答案」。
- **工具**：`ctx_index`/`ctx_search`/`ctx_fetch_and_index`/`ctx_purge`（知识库）+ `ctx_execute`/`ctx_execute_file`/`ctx_batch_execute`（沙箱）+ `ctx_doctor`/`ctx_stats`（诊断/台账）。
- **诚实定位**：`read` 自带约 50KB 上限，本项目是「**引导型省**」（把有界整读引导到精准检索）+「**沙箱执行**」（Think-in-Code，确定性省），不是上游那类"98%"；`ctx_stats` 把 `kept_out_pct_measured`（read 侧精确）与 `total`（含估算/下界）并列展示，不夸大。`codeRuntime` 为资源隔离（非数据沙箱），信任姿态与 bash 同级，不承诺程序无法读写宿主文件。

更多细节见源码注释与 `ctx_doctor`/`ctx_stats` 实测。

## 运行环境

DSH `v0.1.1-rc.2`、Node `>= 24`（`node:sqlite` 免编译 FTS5；type-stripping 直载 `.ts`）。知识库用自有 `node:sqlite`（`~/.context-mode/content`）。
