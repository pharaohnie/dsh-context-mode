// routing/gate.ts — tools/pre-execute 门禁（瀑布事件，命中规则短路 deny，放行走 next()）
// I5 语义：命中规则直接 return {kind:'deny',reason}；放行才 return next()。
// 本文件是 read 整读门禁的权威执行点：pre-execute 是 async（Promise<PreToolDecision>），可 await stat。
// 注意：ctx.tools.guard()（guard.ts）是同步 ToolGuard（(exec)=>string|undefined，guardReason 不 await），
//       因此 read 门禁（需 async stat）只能在 pre-execute 里做，guard 只保留 sync 的 bash-flood 兜底。
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import { floodCommandWord } from '../util/shell-tokenize.ts'

const FLOOD_WORDS = ['curl', 'wget', 'inline-fetch']

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
  if (!cfg.trustedReadBasenames.some((b) => b.toLowerCase() === base)) return false
  return size <= cfg.maxReadBytesBeforeAsk * cfg.trustedDocHeadroom
}

function buildReadDenyReason(filePath: string, size: number, cfg: ReadGateCfg): string {
  const threshold = cfg.maxReadBytesBeforeAsk
  const sizeK = (size / 1024).toFixed(1)
  const thK = (threshold / 1024).toFixed(1)
  return `context-mode: 文件 ${filePath} 有 ${size} 字节（约 ${sizeK} KB），超过整读引导阈值 ${threshold} 字节（约 ${thK} KB），一次整读会撑大上下文窗口（read 自带约 50KB 上限，超限会被截断）。请改用引导路径提取所需内容：① 先用 ctx_index（或 ctx_fetch_and_index）索引该文件，再用 ctx_search 检索所需片段（最省、可复用，主替代）；② 用 run_code 只读取必要切片（按行/字节范围截断）并只打印结论/摘要；③ 用 read 带 offset/limit 的精确读；④ 信任文档（README/CHANGELOG/LICENSE/AGENTS/package.json）可整读。已拒绝本次整读。`
}

/** 共享 read 整读决策（async，纯判定不含计量）：返回 {size,reason} 表示 deny，否则表示放行。
 *  顺序：开关关 → 非文本 read → 无 file_path(fail-open) → 带 offset/limit 精确读(放行) → stat 失败(fail-open)
 *        → 信任文档(basename+headroom 放行) → ≤阈值(fail-open 小读) → 否则 deny。 */
export async function readFloodDecision(exec: any, cfg: ReadGateCfg, stat: (filePath: string) => Promise<number | undefined>): Promise<{ size: number; reason: string } | undefined> {
  if (!cfg.routingEnabled || !cfg.autoGuideRead) return undefined
  if (exec?.name !== 'read') return undefined // 只拦文本 read；read_image 名称不同，天然放行
  const args = exec?.arguments ?? {}
  const filePath = args.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined // fail-open
  if (cfg.readAllowBounded && (args.offset !== undefined || args.limit !== undefined)) return undefined // 显式分段读，放行
  const size = await stat(filePath)
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
  }
  hasApproval: () => boolean
  recordDenied?: (bytes: number) => void
  recordDeniedRead?: (size: number, filePath: string) => void
  /** deny 时上报 rejected-approach 记忆（P1b；低频，按 deny reason 去重）。 */
  recordRejected?: (sid: string, reason: string) => void
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
    const reject = (reason: string) => { const sid = exec?.agent?.sessionId; if (sid) deps.recordRejected?.(sid, reason) }
    try {
      // ① bash 洪水硬 deny（确定性，不走 fail-open）
      if (deps.config.denyCurlWget && name === 'bash') {
        const reason = floodReason(name, args)
        if (reason) {
          deps.recordDenied?.(typeof args.command === 'string' ? args.command.length : 0)
          reject(reason)
          return { kind: 'deny', reason }
        }
      }
      // ② 无界 bash 长命令 -> ask（处理意图：软引导，无审批通道时放行）
      if (name === 'bash' && deps.config.bashNudgeMinCommandBytes > 0) {
        const len = typeof args.command === 'string' ? args.command.length : 0
        if (len > deps.config.bashNudgeMinCommandBytes) {
          const reason = `context-mode: 这条 bash 命令较长（约 ${len} 字节 > 阈值 ${deps.config.bashNudgeMinCommandBytes}），且看起来要拿到较大输出。若你要对结果做分析/计数/过滤/多查询，请改用 ctx_execute(language:"ts", code) 或 ctx_batch_execute(commands, queries)（沙箱里只回答案）；确需看输出用 read 带 offset/limit。`
          // P1 软引导：有审批时 ask（把改用 ctx_* 的提示交给模型/用户裁决）；无审批通道时放行（绝不误拦合法命令）。
          if (deps.hasApproval()) return { kind: 'ask', reason }
          return next()
        }
      }
      // ③ ctx_execute* 安全审查（S1：洪水/长命令判定针对 arguments.code，勿复用只认 bash 的 floodReason）
      if (deps.config.executeEnabled && (name === 'ctx_execute' || name === 'ctx_execute_file' || name === 'ctx_batch_execute')) {
        const lang = typeof args.language === 'string' ? args.language.toLowerCase() : deps.config.executeDefaultLanguage
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
              deps.recordDenied?.(codeStr.length)
              return { kind: 'deny', reason: `context-mode: 检测到确定性洪水工具 "${word}"（会淹没上下文窗口），已拒绝。请改用 ctx_fetch_and_index 索引 + ctx_search 检索，或 ctx_execute(language:"ts",code) 沙箱处理。` }
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
      const decision = await readFloodDecision(exec, deps.config, (fp) => statSize(fp, exec, ctx.get('fs')))
      if (decision) {
        deps.recordDeniedRead?.(decision.size, typeof args.file_path === 'string' ? args.file_path : '')
        const note = deps.contextNote?.()
        reject(decision.reason)
        return { kind: 'deny', reason: note ? `${decision.reason}\n${note}` : decision.reason }
      }
      return next()
    } catch {
      // 门禁自身异常不阻塞调用（fail-open）
      return next()
    }
  }) as never
}
