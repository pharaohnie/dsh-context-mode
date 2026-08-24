// doctor.ts — ctx_doctor：诊断 context-mode 依赖的所有 seam 装配与知识库健康
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import { createSchema, smokeFts5, chunkStats, type KnowledgeDb } from './knowledge/sqlite.ts'
import { envConfigOverrides } from './config.ts'
import { type FloodGuard } from './knowledge/flood-guard.ts'
import { SEARCH_BUDGET_BYTES } from './knowledge/tools.ts'

export interface DoctorDeps {
  tools: unknown
  systemPrompt: unknown
  sessionQuery: unknown
  tokenMeter: unknown
  sessions: unknown
  approval: unknown
  kdb: KnowledgeDb | null
  config?: { autoGuideRead: boolean; readAllowBounded: boolean; maxReadBytesBeforeAsk: number; trustedReadBasenames: string[]; trustedDocHeadroom: number; executeEnabled: boolean; executeAllowShell: boolean; memoryCapture: boolean; adviceStructured: boolean; securityEnabled?: boolean; securityAllowGlobs?: string[]; securityDenyGlobs?: string[]; boundedWhitelist?: string[]; searchWindowMs?: number; searchMaxResultsAfter?: number; searchBlockAfter?: number; subagentGuidance?: boolean }
  codeRuntime?: unknown
  fs?: unknown
  shell?: unknown
  sandboxPolicy?: unknown
  /** P1：搜索 FloodGuard 运行态（per-agent-context 分桶）观测。 */
  floodGuard?: FloodGuard
}

export function registerDoctor(ctx: { tools: { register(def: unknown): unknown }; get(name: string): unknown }, deps: DoctorDeps) {
  ctx.tools.register(defineTool({
    name: 'ctx_doctor',
    description: '诊断 context-mode 插件的 seam 装配状态、知识库健康与宿主能力。只读，不改任何状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: { ok: boolean; lines: string[] }) => [{ type: 'text', text: value.lines.join('\n') }] as any,
    },
    async execute() {
      const lines: string[] = []
      let ok = true
      // 硬依赖（tools/systemPrompt）缺失 -> fail（ok=false）；可选服务缺失 -> degraded（✗ 标注但 ok=true）
      const report = (name: string, status: boolean, detail = '', isHard = false) => {
        lines.push(`${status ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
        if (isHard && !status) ok = false
      }
      report('tools（硬）', deps.tools !== undefined, '', true)
      report('systemPrompt（硬）', deps.systemPrompt !== undefined, '', true)
      // P2：sessionQuery/tokenMeter 是可选服务；apply 时因 loader 并发挂载可能取不到（快照误导），改在 execute 时惰性 ctx.get() 判定。
      const sessionQueryNow = ctx.get('sessionQuery')
      const tokenMeterNow = ctx.get('tokenMeter')
      report('sessionQuery（可选）', sessionQueryNow !== undefined,
        sessionQueryNow !== undefined ? '' : '缺失 -> 会话连续性降级')
      report('tokenMeter（可选）', tokenMeterNow !== undefined,
        tokenMeterNow !== undefined ? '' : '缺失 -> ctx_stats 无压力数据')
      report('sessions（可选）', deps.sessions !== undefined)
      report('approval（可选）', deps.approval !== undefined,
        deps.approval !== undefined ? '' : '缺失 -> ask 走 fail-open 放行+警告')
      // P3-6：不假定 Node 全局可用，统一断言 fetch/setTimeout/AbortController（DSH 指南「先查 Builtins」）
      report('Node 全局（fetch/setTimeout/AbortController）',
        typeof fetch === 'function' && typeof setTimeout === 'function' && typeof AbortController === 'function',
        `fetch=${typeof fetch === 'function'} setTimeout=${typeof setTimeout === 'function'} AbortController=${typeof AbortController === 'function'}`)
      // S3：分开报告「执行 substrate」与「文件策略」——勿把两者混报为同一 sandbox 模式
      const rt = deps.codeRuntime as { isolation?: unknown } | undefined
      report('codeRuntime（执行 substrate）', rt !== undefined,
        rt && rt.isolation !== undefined ? `isolation=${String(rt.isolation)}` : (rt !== undefined ? '已注册（无 isolation 字段）' : '缺失 -> ctx_execute 降级/报错'))
      // sandboxPolicy 是同步 service：resolve(request?) 返回 SandboxExecutionPolicy，且有 defaultMode 属性
      const sp = deps.sandboxPolicy as { defaultMode?: string; resolve?: (req?: unknown) => { mode?: string } } | undefined
      if (sp) {
        let mode = sp.defaultMode !== undefined ? `defaultMode=${String(sp.defaultMode)}` : ''
        if (!mode && typeof sp.resolve === 'function') { try { const r = sp.resolve({}); if (r?.mode) mode = `mode=${String(r.mode)}` } catch { /* 接口未探明 */ } }
        report('sandboxPolicy（文件策略）', true, mode || '已注册')
      } else {
        report('sandboxPolicy（文件策略）', false, '缺失 -> 文件写策略未知')
      }
      // P0 armed 状态
      if (deps.config) {
        report('ctx_execute（P0）', deps.config.executeEnabled,
          deps.config.executeEnabled ? `enabled；shell=${deps.config.executeAllowShell}` : 'executeEnabled=false -> 沙箱执行关闭')
      }
      // P1b 记忆捕获 armed
      if (deps.config) {
        report('会话记忆捕获', deps.config.memoryCapture,
          deps.config.memoryCapture ? '已启用（opt-in，注意隐私）' : '默认关闭（opt-in，B3）')
      }
      // read 整读门禁 armed 状态（A5/A7 辅助：确认规则按配置启用了）
      if (deps.config) {
        report('read 整读门禁', deps.config.autoGuideRead,
          deps.config.autoGuideRead
            ? `已启用：阈值 ${deps.config.maxReadBytesBeforeAsk} 字节，bounded=${deps.config.readAllowBounded}，信任文档=${deps.config.trustedReadBasenames.length} 个（headroom×${deps.config.trustedDocHeadroom}）`
            : 'autoGuideRead=false -> read 从不门禁（回到现状）')
      }
      // P0-2 安全基线 + P1-2 白名单 + P2-1 搜索节流 + P2-3 子代理守卫 armed 状态（对齐官方 ctx_doctor 诊断）
      if (deps.config) {
        report('安全基线（securityEnabled）', deps.config.securityEnabled === true,
          deps.config.securityEnabled === true ? `已启用：allow=${deps.config.securityAllowGlobs?.length ?? 0} 条，deny=${deps.config.securityDenyGlobs?.length ?? 0} 条（R5-8 诚实标注：当前仅作用于 read 的 file_path，不覆盖 bash/ctx_index/ctx_execute_file 目标路径）` : '默认关闭（P0-2，避免强开打扰）')
        report('结构白名单（boundedWhitelist）', Array.isArray(deps.config.boundedWhitelist) && deps.config.boundedWhitelist.length > 0,
          `已启用：${deps.config.boundedWhitelist?.length ?? 0} 个无害命令零摩擦放行`)
        report('搜索 FloodGuard（searchBlockAfter）', (deps.config.searchBlockAfter ?? 0) > 0,
          `已启用：window=${deps.config.searchWindowMs ?? 60000}ms，软上限=${deps.config.searchMaxResultsAfter ?? 3}，硬上限=${deps.config.searchBlockAfter ?? 8}`)
        report('子代理守卫（subagentGuidance）', deps.config.subagentGuidance === true,
          deps.config.subagentGuidance === true ? '已启用：给子代理注入 context_window_protection' : '默认关闭（P2-3）')
      }
      // P4：实际生效的 env 覆盖（实时读取；展示 env 覆盖了哪些键，让调参透明）
      try {
        const envOver = envConfigOverrides()
        const keys = Object.keys(envOver)
        if (keys.length) {
          const detail = keys.map((k) => `${k}=${JSON.stringify((envOver as Record<string, unknown>)[k])}`).join(', ')
          report('env 覆盖（CONTEXT_MODE_*）', true, detail)
        } else {
          report('env 覆盖（CONTEXT_MODE_*）', true, '无（默认 + bundle/rawConfig）')
        }
      } catch (e) {
        report('env 覆盖（CONTEXT_MODE_*）', false, String((e as Error).message))
      }
      // P4：FloodGuard 运行态（per-agent-context 分桶；sessionId 截断展示，不泄全文）
      if (deps.floodGuard) {
        try {
          const snap = deps.floodGuard.snapshot()
          if (snap.disabled) {
            report('FloodGuard 运行态', false, '已禁用（windowMs<=0 或 blockAfter<=0）')
          } else {
            const top = snap.buckets.slice(0, 3).map((b) => `${b.key.slice(0, 8)}:${b.count}`).join(' ')
            report('FloodGuard 运行态', !snap.disabled,
              `活跃桶 ${snap.buckets.length}/${snap.maxKeys}${top ? '（top: ' + top + '）' : ''}`)
          }
        } catch (e) {
          report('FloodGuard 运行态', false, String((e as Error).message))
        }
      } else {
        report('FloodGuard 运行态', false, '未注入（registerDoctor 未传 floodGuard）')
      }
      // 知识库：真实路径可写 + schema 建表；FTS5 冒烟在内存库跑（避免污染真实数据）
      if (deps.kdb) {
        report('知识库建表', true, deps.kdb.file)
        // P4：分片统计（live/expired 惰性量，下次检索才清）
        try {
          const cs = chunkStats(deps.kdb.db)
          report('知识库分片', cs.live > 0 || cs.expired > 0,
            `live ${cs.live} / expired ${cs.expired} / total ${cs.total}（${cs.bytes} 字节；检索预算 ${SEARCH_BUDGET_BYTES}/次）`)
        } catch (e) {
          report('知识库分片', false, String((e as Error).message))
        }
      } else {
        report('知识库', false, '目录不可写/打开失败')
      }
      try {
        const mem = new DatabaseSync(':memory:')
        createSchema(mem)
        const s = smokeFts5(mem)
        report('FTS5 冒烟（porter/trigram/bm25weight）', s.porter && s.trigram && s.weight,
          `porter=${s.porter} trigram=${s.trigram} bm25=${s.weight}`)
        mem.close()
      } catch (e) {
        report('FTS5 冒烟', false, String((e as Error).message))
      }
      return { ok, lines }
    },
  }))
}
