// doctor.ts — ctx_doctor：诊断 context-mode 依赖的所有 seam 装配与知识库健康
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import { createSchema, smokeFts5, type KnowledgeDb } from './knowledge/sqlite.ts'

export interface DoctorDeps {
  tools: unknown
  systemPrompt: unknown
  sessionQuery: unknown
  tokenMeter: unknown
  sessions: unknown
  approval: unknown
  kdb: KnowledgeDb | null
  config?: { autoGuideRead: boolean; readAllowBounded: boolean; maxReadBytesBeforeAsk: number; trustedReadBasenames: string[]; trustedDocHeadroom: number; executeEnabled: boolean; executeAllowShell: boolean; memoryCapture: boolean; adviceStructured: boolean }
  codeRuntime?: unknown
  fs?: unknown
  shell?: unknown
  sandboxPolicy?: unknown
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
      // 知识库：真实路径可写 + schema 建表；FTS5 冒烟在内存库跑（避免污染真实数据）
      if (deps.kdb) {
        report('知识库建表', true, deps.kdb.file)
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
