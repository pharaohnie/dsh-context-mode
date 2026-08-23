// routing/guard.ts — ctx.tools.guard() 单调最终 deny（只能收、不能放）
// 二次防线：若 gate 因某种原因放行了 bash 洪水调用，这里兜底拒绝（返回 reason 即 deny）。
// 注意：ToolGuard = (execution) => string | undefined，是同步签名（guardReason 不 await，见 dsh-tools）。
// 因此 read 整读门禁（需 async stat）只能在 pre-execute 的 gate.ts 里做，本文件不拦 read（保持同步、避免误拒）。
import { floodReason } from './gate.ts'
import { floodCommandWord } from '../util/shell-tokenize.ts'

const FLOOD_WORDS = ['curl', 'wget', 'inline-fetch']

export interface GuardDeps {
  config: { routingEnabled: boolean; denyCurlWget: boolean; executeEnabled: boolean; executeAllowShell: boolean }
}

export function registerGuard(ctx: { tools: { guard(fn: (exec: any) => string | undefined): unknown } }, deps: GuardDeps) {
  if (!deps.config.routingEnabled || !deps.config.denyCurlWget) return
  ctx.tools.guard((exec) => {
    // ① bash 洪水（调用 floodReason）
    const bashReason = floodReason(exec?.name, exec?.arguments ?? {})
    if (bashReason) return bashReason
    // ② ctx_execute(shell) 洪水同步兜底（S1：读 arguments.code，勿复用只认 bash 的 floodReason）
    const name = exec?.name
    if (deps.config.executeEnabled && deps.config.executeAllowShell && (name === 'ctx_execute' || name === 'ctx_execute_file' || name === 'ctx_batch_execute')) {
      const args = exec?.arguments ?? {}
      const lang = typeof args.language === 'string' ? args.language.toLowerCase() : 'ts'
      if (lang === 'shell' || lang === 'bash') {
        const codeStr = name === 'ctx_batch_execute'
          ? (Array.isArray(args.commands) ? args.commands.join('\n') : '')
          : (typeof args.code === 'string' ? args.code : '')
        const word = floodCommandWord(codeStr)
        if (FLOOD_WORDS.includes(word)) {
          return `context-mode: 检测到确定性洪水工具 "${word}"（会淹没上下文窗口），已拒绝。请改用 ctx_fetch_and_index 索引 + ctx_search 检索。`
        }
      }
    }
    return undefined
  })
}
