// routing/gate.ts — tools/pre-execute 门禁（瀑布事件，命中规则短路 deny，放行走 next()）
// I5 语义：命中规则直接 return {kind:'deny',reason}；放行才 return next()。
// 本文件是 read 整读门禁的权威执行点：pre-execute 是 async（Promise<PreToolDecision>），可 await stat。
// 注意：ctx.tools.guard()（guard.ts）是同步 ToolGuard（(exec)=>string|undefined，guardReason 不 await），
//       因此 read 门禁（需 async stat）只能在 pre-execute 里做，guard 只保留 sync 的 bash-flood 兜底。
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import { floodCommandWord, firstCommandWord, hasShellControlOps, FLOOD_WORDS } from '../util/shell-tokenize.ts' // R5-5（S-L1）：洪水词单源（shell-tokenize）

/** 结构性有界判定（P1-2）：命令为白名单单命令 + 无 shell 控制运算符 → 无害，应零摩擦放行。
 *  对齐官方 isStructurallyBounded：只要首个命令词在白名单、且命令串无控制运算符，就放行（不进长命令 ask/门槛）。 */
export function isStructurallyBounded(command: string, whitelist: string[]): boolean {
  if (!command) return false
  if (hasShellControlOps(command)) return false // 有控制运算符（管道/串联/重定向/子shell）＝非单命令
  const first = firstCommandWord(command)
  if (!first) return false
  return whitelist.some((w) => w.toLowerCase() === first)
}

/** 简单 glob 匹配（P0-2 安全基线）：`*` 匹配任意不含 `/` 的子串，`?` 单个字符；其余按前缀匹配。
 *  仅用于 basename/相对路径的 allow/deny 判定，非完整文件系统语义（对齐官方 permissions 的近似）。 */
export function globMatch(target: string, glob: string): boolean {
  const g = glob.replace(/\\/g, '/').toLowerCase()
  const t = target.replace(/\\/g, '/').toLowerCase()
  const rx = '^' + g.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$'
  try { return new RegExp(rx).test(t) } catch { return false }
}

/** P0-2 安全基线判定：securityEnabled=false → undefined（不干预）；true 时按 allow/deny glob fail-closed。
 *  顺序：命中 allow → 放行(undefined)；命中 deny 未 allow → 返回 deny reason；两 globs 均空 → 放行（不预设规则不拦）。 */
export function securityDecision(target: string, cfg: { securityEnabled: boolean; securityAllowGlobs: string[]; securityDenyGlobs: string[] }): string | undefined {
  if (!cfg.securityEnabled) return undefined
  const allowed = cfg.securityAllowGlobs.some((g) => globMatch(target, g))
  if (allowed) return undefined
  const denied = cfg.securityDenyGlobs.some((g) => globMatch(target, g))
  if (denied) return `context-mode: 安全策略（securityEnabled）拒绝访问 ${target}（命中 deny glob；允许名单未命中）。`
  return undefined
}

/** 共享洪水规则：bash 命令的任一命令段首词为 flood 工具时返回 deny reason，否则 undefined。
 *  用 floodCommandWord 扫描全部命令段（识别重定向目标/sudo -u/env -i/路径basename/bash -c 等绕行）。 */
export function floodReason(name: string, args: Record<string, unknown> | null | undefined): string | undefined {
  if (name !== 'bash') return undefined
  const command = args?.command
  if (typeof command !== 'string') return undefined
  const word = floodCommandWord(command)
  return FLOOD_WORDS.includes(word)
    ? `context-mode: 检测到确定性洪水工具 "${word}"（会淹没上下文窗口），已拒绝。请改用 ctx_index 索引 + ctx_search 检索，或用 run_code 沙箱执行并只打印必要输出。`
    : undefined
}

/** 只拦文本 `read`（applyReadTool 注册 name:"read"；图像工具名为 `read_image`，天然放行——无检索等价物）。 */
export interface ReadGateCfg {
  routingEnabled: boolean
  autoGuideRead: boolean
  readAllowBounded: boolean
  maxReadBytesBeforeAsk: number
  trustedReadBasenames: string[]
  trustedDocHeadroom: number
}

/** 解析文件大小：优先镜像 read 工具的 fs.resolve+stat（相对路径按 session cwd 解析、sandbox 友好），
 *  失败回退 node:fs.statSync（按其宿主 cwd），全部 fail-open（拿不到 size 就不拦，绝不误拒一次合法读）。 */
export async function statSize(filePath: string, exec: any, fsSvc: any): Promise<number | undefined> {
  if (fsSvc && typeof fsSvc.resolve === 'function' && typeof fsSvc.stat === 'function') {
    try {
      const cwd = exec?.agent?.session?.header?.cwd
      const target = await fsSvc.resolve(filePath, cwd ? { cwd } : undefined)
      if (target == null) return undefined
      const info = await fsSvc.stat(target, exec?.signal)
      if (info && typeof info.size === 'number') return info.size
    } catch { /* 走 fallback */ }
  }
  try {
    const st = nodeFs.statSync(filePath)
    if (st && typeof st.size === 'number') return st.size
  } catch { /* 不存在/无权限 → fail-open */ }
  return undefined
}

function isTrustedRead(filePath: string, size: number, cfg: ReadGateCfg): boolean {
  const base = nodePath.basename(filePath).toLowerCase()
  // R2-2（B-H02）：去扩展名匹配——白名单 README 应命中 README.md；package.json 全名精确匹配
  const stem = base.replace(/\.[^.]+$/, '')
  if (!cfg.trustedReadBasenames.some((b) => {
    const item = b.toLowerCase()
    return base === item || stem === item
  })) return false
  return size <= cfg.maxReadBytesBeforeAsk * cfg.trustedDocHeadroom
}

function buildReadDenyReason(filePath: string, size: number, cfg: ReadGateCfg): string {
  const threshold = cfg.maxReadBytesBeforeAsk
  const sizeK = (size / 1024).toFixed(1)
  const thK = (threshold / 1024).toFixed(1)
  return `context-mode: 文件 ${filePath} 有 ${size} 字节（约 ${sizeK} KB），超过整读引导阈值 ${threshold} 字节（约 ${thK} KB），一次整读会撑大上下文窗口（read 自带约 50KB 上限，超限会被截断）。请改用引导路径提取所需内容：① 先用 ctx_index（或 ctx_fetch_and_index）索引该文件，再用 ctx_search 检索所需片段（最省、可复用，主替代）；② 用 run_code 只读取必要切片（按行/字节范围截断）并只打印结论/摘要；③ 用 read 带**有界** offset/limit（limit ≤ 阈值）的精确读；④ 信任文档（README/CHANGELOG/LICENSE/AGENTS/package.json）可整读。已拒绝本次整读。`
}

/** 共享 read 整读决策（async，纯判定不含计量）：返回 {size,reason} 表示 deny，否则表示放行。
 *  顺序：开关关 → 非文本 read → 无 file_path(fail-open) → stat → 有界分段读(limit≤阈值，放行) → stat 失败(fail-open)
 *        → 信任文档(去扩展名 basename+headroom 放行) → ≤阈值(fail-open 小读) → 否则 deny。 */
export async function readFloodDecision(exec: any, cfg: ReadGateCfg, stat: (filePath: string) => Promise<number | undefined>): Promise<{ size: number; reason: string } | undefined> {
  if (!cfg.routingEnabled || !cfg.autoGuideRead) return undefined
  if (exec?.name !== 'read') return undefined // 只拦文本 read；read_image 名称不同，天然放行
  const args = exec?.arguments ?? {}
  const filePath = args.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined // fail-open
  const size = await stat(filePath) // R2-3：提前 stat，供「有界分段读」判定
  // R2-3（S-M4）：只放行「显式行数上限 ≤ 阈值」的分段读；无 limit 或 limit 超阈 → 继续整读判定。
  // read 工具自身仍有 ~50KB 截断兜底，放行的分段读不会突破单次返回量。
  if (cfg.readAllowBounded && typeof args.limit === 'number' && args.limit > 0 && args.limit <= cfg.maxReadBytesBeforeAsk) {
    return undefined
  }
  if (size === undefined) return undefined // stat 失败/不存在 → fail-open
  if (isTrustedRead(filePath, size, cfg)) return undefined
  if (size <= cfg.maxReadBytesBeforeAsk) return undefined // 小读不计，零摩擦
  return { size, reason: buildReadDenyReason(filePath, size, cfg) }
}

export interface GateDeps {
  config: {
    routingEnabled: boolean
    denyCurlWget: boolean
    bashNudgeMinCommandBytes: number
    readAllowBounded: boolean
    autoGuideRead: boolean
    maxReadBytesBeforeAsk: number
    trustedReadBasenames: string[]
    trustedDocHeadroom: number
    executeEnabled: boolean
    executeAllowShell: boolean
    executeDefaultLanguage: string
    boundedWhitelist: string[]
    securityEnabled: boolean
    securityAllowGlobs: string[]
    securityDenyGlobs: string[]
  }
  hasApproval: () => boolean
  recordDenied?: (bytes: number) => void
  /** 洪水工具被「改道」（redirect）的分类记账：命令串长度作为免受上下文冲击的字节下界。 */
  recordRedirect?: (bytes: number) => void
  recordDeniedRead?: (size: number, filePath: string) => void
  /** deny 时上报 rejected-approach 记忆（P1b；低频，按 deny reason 去重）。 */
  recordRejected?: (sid: string, reason: string) => void
  /** rejected-approach 分类记账：deny reason 文本长度作为字节下界（P0-1 度量）。 */
  recordRejectedBytes?: (bytes: number) => void
  /** deny 时附加的一次性回流文本（低频事件，不常驻 prompt）。 */
  contextNote?: () => string | undefined
}

export function registerGate(ctx: {
  on(event: string, listener: (...a: never[]) => unknown): void
  get(name: string): unknown
}, deps: GateDeps) {
  ctx.on('tools/pre-execute' as never, async (exec: any, next: () => Promise<unknown>) => {
    if (!deps.config.routingEnabled) return next()
    const name = exec?.name
    const args = exec?.arguments ?? {}
    const reject = (reason: string) => {
      const sid = exec?.agent?.sessionId
      if (sid) deps.recordRejected?.(sid, reason)
      deps.recordRejectedBytes?.(typeof reason === 'string' ? reason.length : 0)
    }
    try {
      // ① bash 洪水硬 deny（确定性，不走 fail-open）
      if (deps.config.denyCurlWget && name === 'bash') {
        const reason = floodReason(name, args)
        if (reason) {
          const cmdLen = typeof args.command === 'string' ? args.command.length : 0
          deps.recordDenied?.(cmdLen)
          deps.recordRedirect?.(cmdLen) // 洪水工具被改道（redirect 分类）
          reject(reason)
          return { kind: 'deny', reason }
        }
      }
      // ①.5 结构性有界白名单（P1-2）：无害单命令（白名单 + 无控制运算符）→ 零摩擦放行，不碰长命令 ask。
      if (name === 'bash' && typeof args.command === 'string' && isStructurallyBounded(args.command, deps.config.boundedWhitelist)) {
        return next()
      }
      // ② 无界 bash 长命令 -> ask（处理意图：软引导，无审批通道时放行）
      if (name === 'bash' && deps.config.bashNudgeMinCommandBytes > 0) {
        const len = typeof args.command === 'string' ? args.command.length : 0
        if (len > deps.config.bashNudgeMinCommandBytes) {
          const reason = `context-mode: 这条 bash 命令较长（约 ${len} 字节 > 阈值 ${deps.config.bashNudgeMinCommandBytes}），且看起来要拿到较大输出。若你要对结果做分析/计数/过滤/多查询，请改用 ctx_execute(language:"ts", code) 或 ctx_batch_execute(commands, queries)（沙箱里只回答案）；确需看输出用 read 带 offset/limit。`
          // P1 软引导：有审批时 ask（把改用 ctx_* 的提示交给模型/用户裁决）；无审批通道时放行（绝不误拦合法命令）。
          if (deps.hasApproval()) return { kind: 'ask', reason }
          console.warn('[context-mode] 无审批通道：长 bash 命令放行（仅记录，不拦截）:', String(args.command).slice(0, 120)) // R5-6（S-L2）：与 doctor 文案「放行+警告」对齐
          return next()
        }
      }
      // ③ ctx_execute* 安全审查（S1：洪水/长命令判定针对 arguments.code，勿复用只认 bash 的 floodReason）
      if (deps.config.executeEnabled && (name === 'ctx_execute' || name === 'ctx_execute_file' || name === 'ctx_batch_execute')) {
        const lang = typeof args.language === 'string'
          ? args.language.toLowerCase()
          : (name === 'ctx_execute_file' ? 'ts' : deps.config.executeDefaultLanguage) // R3-5（B-08c）：file 工具实际回退 'ts'
        const isShell = lang === 'shell' || lang === 'bash'
        // shell 路由默认拒绝（executeAllowShell=false），引导到 ts 或 ctx_fetch_and_index
        if (isShell && !deps.config.executeAllowShell) {
          const reason = `context-mode: ctx_* 的 shell 路由默认关闭（executeAllowShell=false）。请改用 ① ctx_execute(language:"ts", code) 只算并只打印答案；② 抓网页用 ctx_fetch_and_index；③ 过滤/统计用 ctx_batch_execute。`
          reject(reason)
          return { kind: 'deny', reason }
        }
        // shell 且允许：对 code 做洪水/长命令判定（S1，读 arguments.code）
        if (isShell && deps.config.executeAllowShell) {
          const codeStr = name === 'ctx_batch_execute'
            ? (Array.isArray(args.commands) ? args.commands.join('\n') : '')
            : (typeof args.code === 'string' ? args.code : '')
          if (deps.config.denyCurlWget) {
            const word = floodCommandWord(codeStr)
            if (FLOOD_WORDS.includes(word)) {
              const reason = `context-mode: 检测到确定性洪水工具 "${word}"（会淹没上下文窗口），已拒绝。请改用 ctx_fetch_and_index 索引 + ctx_search 检索，或 ctx_execute(language:"ts",code) 沙箱处理。`
              deps.recordDenied?.(codeStr.length)
              deps.recordRedirect?.(codeStr.length) // 洪水改道分类
              reject(reason) // R3-4（B-08b）：与 bash 分支对齐，补记 rejected-approach / rejected_bytes
              return { kind: 'deny', reason }
            }
          }
          const len = codeStr.length
          if (deps.config.bashNudgeMinCommandBytes > 0 && len > deps.config.bashNudgeMinCommandBytes) {
            return { kind: 'ask', reason: `context-mode: 这条 shell 代码较长（约 ${len} 字节 > 阈值 ${deps.config.bashNudgeMinCommandBytes}），建议用 ctx_execute(language:"ts",code) 或 run_code 沙箱。` }
          }
        }
        // ts/js：沙箱内跑是合法意图，放行（fail-open，不 gate）
        // path 解析失败/无 code → 在工具内 fail-open，门禁不 deny
      }
      // ④ read 整读门禁（async：await stat；只拦文本 read，read_image 放行；run_code 子分派不豁免，统一按 size 判）
      const sep = securityDecision(typeof args.file_path === 'string' ? args.file_path : '', {
        securityEnabled: deps.config.securityEnabled,
        securityAllowGlobs: deps.config.securityAllowGlobs,
        securityDenyGlobs: deps.config.securityDenyGlobs,
      })
      if (sep) {
        reject(sep)
        return { kind: 'deny', reason: sep }
      }
      const decision = await readFloodDecision(exec, deps.config, (fp) => statSize(fp, exec, ctx.get('fs')))
      if (decision) {
        deps.recordDeniedRead?.(decision.size, typeof args.file_path === 'string' ? args.file_path : '')
        const note = deps.contextNote?.()
        reject(decision.reason)
        return { kind: 'deny', reason: note ? `${decision.reason}\n${note}` : decision.reason }
      }
      return next()
    } catch (e) {
      // R5-2（B-08f）：门禁自身异常不阻塞调用（fail-open），但记录日志便于诊断
      console.warn('[context-mode] 门禁异常（fail-open 放行）:', (e as Error).message)
      return next()
    }
  }) as never
}
