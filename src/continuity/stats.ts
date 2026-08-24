// continuity/stats.ts — ctx_stats：自建 savedBytes 台账（measured/total 口径并列，S7）+ tokenMeter 当前压力（额外展示）
import { defineTool } from '@deepseek-ai/dsh-tools'
import { computeSavedBytes, getMeta, type KnowledgeDb } from '../knowledge/sqlite.ts'

export interface StatsDeps { kdb: KnowledgeDb | null; accountingLedger?: boolean }

export function registerStats(ctx: {
  tools: { register(def: unknown): unknown }
  get(name: string): unknown
}, deps: StatsDeps) {
  ctx.tools.register(defineTool({
    name: 'ctx_stats',
    description: '查看 context-mode 的上下文节约统计：已索引字节、检索返还字节、拒绝洪水（read 实际拦截[精确] + curl/wget 下界）、沙箱执行/记忆计数，以及 kept_out_pct（measured 仅 read 侧口径 + total 含估算，并列展示）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'number', required: true },
        },
      },
      render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] as any,
    },
    async execute(_args: unknown, exec: any) {
      const lines: string[] = []
      let saved = 0
      if (deps.kdb) {
        const m = computeSavedBytes(deps.kdb.db)
        const executeRuns = getMeta(deps.kdb.db, 'execute_runs')
        const memoryChunks = getMeta(deps.kdb.db, 'memory_chunks')
        saved = m.savedMeasured
        lines.push('context-mode 节约台账（knowledge db 持久化）：')
        lines.push(`  已索引: ${m.indexed} 字节`)
        lines.push(`  检索返还: ${m.search} 字节`)
        // 口径诚实：read 是真实 stat.size（按文件去重）；curl/wget 只有命令串长度，属「下界」而非精确值。
        lines.push(`  拒绝洪水: ${m.readDenied + m.cmdDenied} 字节（read 实际拦截 ${m.readDenied}[精确/去重] + curl/wget 命令串 ${m.cmdDenied}[下界]）`)
        // P0-1 度量闭环：分类事件（redirect/retrieval/rejected），让 kept_out_pct 更接近官方 measured 口径。
        // accountingLedger=true 展示明细（默认关，避免噪音）；核心 kept_out_pct 始终展示。
        if (deps.accountingLedger) {
          lines.push(`  [明细] 洪水改道(redirect): ${m.redirect} 字节 | 检索命中(retrieval): ${m.retrieval} 字节 | 拒绝回传(rejected): ${m.rejected} 字节`)
        }
        lines.push(`  沙箱执行: ${executeRuns} 次、返回日志 ${m.executeLog} 字节（成本侧，不计入精确节约）`)
        lines.push(`  记忆捕获: ${memoryChunks} 个 chunk、${getMeta(deps.kdb.db, 'memory_bytes')} 字节`)
        // S7：measured 仅 read 侧口径，与 total 并列，勿单列 measured 当结论
        lines.push(`  kept_out_pct: measured=${m.keptOutMeasured.toFixed(1)}%（read 侧精确 + 洪水改道[下界]） | total=${m.keptOutTotal.toFixed(1)}%（含 索引-检索 粗差 + 命令串下界[估算]）`)
        // R5-1（D-H3）：默认只展示 measured（可证伪）；estimate 在 accountingLedger 明细单列，避免混口径高估。
        lines.push(`  节约（measured，可证伪）: ${m.savedMeasured} 字节（≈${Math.round(m.savedMeasured / 4)} tokens）`)
        if (deps.accountingLedger) lines.push(`  [明细] 节约（estimate，含索引-检索粗差+rejected 下界）: ${m.savedEstimate} 字节`)
      } else {
        lines.push('知识库未就绪，无法统计。')
      }
      // tokenMeter 当前压力（resolve session via exec.agent；只取标量，不序列化 live data）
      try {
        const tokenMeter = ctx.get('tokenMeter') as any
        const sessions = ctx.get('sessions') as any
        const sid = exec?.agent?.sessionId
        const session = sid && sessions ? sessions.get(sid) : undefined
        if (tokenMeter && session && typeof tokenMeter.measure === 'function') {
          const m = tokenMeter.measure(session)
          lines.push(`当前上下文压力: total=${m.totalTokens} surface=${m.surfaceTokens} surfaceDelta=${m.surfaceDeltaTokens} logRevision=${m.logRevision}`)
        }
      } catch { /* tokenMeter 不可用则跳过，不阻塞报告 */ }
      return { text: lines.join('\n'), count: saved }
    },
  }))
}
