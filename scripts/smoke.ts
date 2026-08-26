// scripts/smoke.ts — P1/P4/P5 纯逻辑回归（node 直跑，无需 DSH 运行时）
// 用法：node scripts/smoke.ts （Node >= 24，type-stripping 直载 .ts，与插件运行姿态一致）
// 覆盖：FloodGuard 分桶（阈值/双 key 独立/maxKeys 淘汰/disabled/滚动重置/空 key）、
//       chunkStats（total/live/expired/bytes）、advice 构建（关键词/长度/去重）、envConfigOverrides。
import { createFloodGuard } from '../src/knowledge/flood-guard.ts'
import { createSchema, chunkStats, addChunk, searchChunks } from '../src/knowledge/sqlite.ts'
import { buildStructured, buildLean } from '../src/routing/advice.ts'
import { sandboxErrorHint, runSandbox } from '../src/knowledge/execute.ts'
import { assertSafeUrl } from '../src/knowledge/web.ts'
import { collectFiles } from '../src/knowledge/tools.ts'
import { readFloodDecision } from '../src/routing/gate.ts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed++
}

// ── P1：FloodGuard per-agent-context 分桶 ──
{
  // 单 key 阈值序列：3 次 ok → 4..8 次 taper → 9 次起 block（原语义不变）
  const g = createFloodGuard(60_000, 3, 8)
  const seq: string[] = []
  for (let i = 0; i < 9; i++) seq.push(g.record('k1'))
  check('P1 单桶阈值 ok/taper/block', seq.join(',') === 'ok,ok,ok,taper,taper,taper,taper,taper,block', seq.join(','))
}
{
  // 双 key 独立预算：k1 打满 block 后，k2 首调仍 ok（核心修复点，对齐官方 #769）
  const g = createFloodGuard(60_000, 3, 8)
  for (let i = 0; i < 9; i++) g.record('a')
  check('P1 已 block 后该 key 仍 block', g.record('a') === 'block', String(g.record('a')))
  const firstB = g.record('b')
  check('P1 双 key 独立（b 首调 ok）', firstB === 'ok', String(firstB))
}
{
  // maxKeys 淘汰：超上限淘汰最旧桶，fail-open 不误伤
  const g = createFloodGuard(60_000, 3, 8, 4)
  for (let i = 0; i < 10; i++) g.record(`k${i}`)
  const n = g.snapshot().buckets.length
  check('P1 maxKeys 淘汰后桶数≤4', n <= 4, `buckets=${n}`)
  const evicted = g.record('k0') // k0 是最早建的，应已被淘汰 → 新窗口 ok
  check('P1 淘汰后 fail-open ok', evicted === 'ok', String(evicted))
}
{
  // disabled：windowMs<=0 → 恒 ok
  const g = createFloodGuard(0, 3, 8)
  check('P1 disabled（windowMs=0）恒 ok', g.record('x') === 'ok' && g.snapshot().disabled === true)
}
{
  // 窗口滚动：同 key 老窗口过期 → 新窗口重置 ok
  const g = createFloodGuard(60_000, 3, 8)
  for (let i = 0; i < 9; i++) g.record('w', 1000)
  const afterReset = g.record('w', 1000 + 60_001)
  check('P1 窗口滚动重置（新窗口 ok）', afterReset === 'ok', String(afterReset))
}
{
  // 空 key → 'default' 桶；snapshot 结构正确
  const g = createFloodGuard(60_000, 3, 8)
  g.record('')
  const snap = g.snapshot()
  check('P1 空 key → default 桶', snap.buckets.length === 1 && snap.buckets[0]?.key === 'default' && snap.buckets[0]?.count === 1)
  check('P1 snapshot 字段完整', snap.windowMs === 60_000 && snap.maxAfter === 3 && snap.blockAfter === 8 && snap.maxKeys === 4096)
}

// ── P4：chunkStats ──
{
  const mem = new DatabaseSync(':memory:')
  createSchema(mem)
  const now = Date.now()
  addChunk(mem, 'r1', 't1', 'body one', 86_400_000, now)   // live
  addChunk(mem, 'r2', 't2', 'body two', 86_400_000, now)   // live
  addChunk(mem, 'r3', 't3', 'body three', -1, now)         // 立即过期
  const cs = chunkStats(mem, now)
  check('P4 chunkStats total=3', cs.total === 3, String(cs.total))
  check('P4 chunkStats live=2', cs.live === 2, String(cs.live))
  check('P4 chunkStats expired=1', cs.expired === 1, String(cs.expired))
  check('P4 chunkStats bytes>0', cs.bytes > 0, String(cs.bytes))
  // R0-1：chunkStats 字节口径（CJK：1 字 = 3 UTF-8 字节；BLOB length 才是真字节数）
  addChunk(mem, 'r-cjk', 't-cjk', '中'.repeat(100), 86_400_000, now)
  const csCjk = chunkStats(mem, now)
  check('R0 chunkStats CJK 字节增量=300', csCjk.bytes - cs.bytes === 300, String(csCjk.bytes - cs.bytes))
  mem.close()
}

// ── P5：advice 构建 ──
{
  const adviceDeps = {
    enabled: true,
    maxReadBytesBeforeAsk: 51200,
    budgetBytes: 12000,
    trustedReadBasenames: ['README', 'CHANGELOG', 'LICENSE', 'AGENTS', 'package.json'],
    adviceStructured: true,
    adviceRich: true,
    executeDefaultLanguage: 'ts',
  }
  const structured = buildStructured(adviceDeps)()
  check('P5 structured 含工具选择层级', structured.includes('tool_selection_hierarchy'))
  check('P5 structured 含 ctx_commands', structured.includes('ctx_commands'))
  check('P5 structured 不再有独立 Memory continuity 节', !structured.includes('## Memory continuity'))
  check('P5 structured 层级含 MEMORY/GATHER/FOLLOW-UP/PROCESSING',
    ['MEMORY', 'GATHER', 'FOLLOW-UP', 'PROCESSING'].every((s) => structured.includes(s)))
  check('P5 structured 长度可控(<3600)', structured.length < 3600, `len=${structured.length}`)
  const lean = buildLean(adviceDeps)()
  check('P5 lean 含层级概要', lean.includes('层级'))
  check('P5 lean 含 ctx_commands 触发词', lean.includes('ctx purge'))
  // A3（2026-08-25）：沙箱契约关键词必须出现在两种引导文本中
  check('P5 structured 含沙箱契约（require 不可用）', structured.includes('无 require'))
  check('P5 structured 含 dynamic import 指引', structured.includes('await import'))
  check('P5 structured 含 FILE_SRC 契约', structured.includes('完整内容'))
  check('P5 lean 含沙箱契约精简版', lean.includes('无 require'))
  check('P5 lean 含 dynamic import 指引', lean.includes('await import'))
}

// ── A2：sandboxErrorHint（沙箱无模块系统错误的改写指引）──
{
  const hitRequire = sandboxErrorHint('ReferenceError: require is not defined')
  check('A2 require 未定义命中', hitRequire.includes('await import'), hitRequire.slice(0, 40))
  check('A2 Cannot use import statement 命中', sandboxErrorHint('SyntaxError: Cannot use import statement outside a module').length > 0)
  check('A2 module 未定义命中', sandboxErrorHint('ReferenceError: module is not defined').length > 0)
  check('A2 import 未定义命中', sandboxErrorHint('ReferenceError: import is not defined').length > 0)
  check('A2 普通 ReferenceError 不命中', sandboxErrorHint('ReferenceError: foo is not defined') === '')
  check('A2 undefined 错误不命中', sandboxErrorHint('TypeError: Cannot read properties of undefined') === '')
  check('A2 空串安全', sandboxErrorHint('') === '')
  check('A2 指引含 FILE_SRC 改写方向', hitRequire.includes('FILE_SRC'))
  check('A2 指引含 shell 逃生口', hitRequire.includes('shell'))
}

// ── B-02：runSandbox shell 路由须走 shell.resolve + sandboxPolicy ──
{
  let resolveCalled = false
  let runSpec: any = null
  const mockPolicy = { mode: 'workspace-write' }
  const ctx = {
    get(name: string) {
      if (name === 'shell') {
        return {
          resolve(req: any) {
            resolveCalled = true
            return { ...req, sandboxPolicy: mockPolicy }
          },
          async run(spec: any) {
            runSpec = spec
            return { stdout: 'ok' }
          },
        }
      }
      return undefined
    },
  }
  const res = await runSandbox(ctx, 'echo hi', 'shell')
  check('B-02 shell.resolve 被调用', resolveCalled)
  check('B-02 run 收到 sandboxPolicy', runSpec?.sandboxPolicy?.mode === 'workspace-write', JSON.stringify(runSpec?.sandboxPolicy))
  check('B-02 无 policy 错字段', runSpec?.policy === undefined, JSON.stringify(runSpec))
  check('B-02 shell 输出', res.text === 'ok', res.text)
}
{
  // fallback：无 shell.resolve 时仍注入 sandboxPolicy（非 policy）
  let runSpec: any = null
  const ctx = {
    get(name: string) {
      if (name === 'shell') {
        return {
          async run(spec: any) {
            runSpec = spec
            return { stdout: 'fallback', stderr: '' }
          },
        }
      }
      if (name === 'sandboxPolicy') {
        return { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only' }) }
      }
      return undefined
    },
  }
  await runSandbox(ctx, 'pwd', 'bash')
  check('B-02 fallback sandboxPolicy', runSpec?.sandboxPolicy?.mode === 'read-only', JSON.stringify(runSpec))
  check('B-02 fallback 无 policy 字段', runSpec?.policy === undefined)
}

// ── P4：envConfigOverrides（依赖 schemastery，不可用则 SKIP 不计失败）──
try {
  const { envConfigOverrides } = await import('../src/config.ts')
  const over = envConfigOverrides({ CONTEXT_MODE_SEARCH_WINDOW_MS: '123' })
  check('P4 env 覆盖生效（searchWindowMs=123）', over.searchWindowMs === 123, String(over.searchWindowMs))
  const noOver = envConfigOverrides({})
  check('P4 无 env 时不覆盖', Object.keys(noOver).length === 0, String(Object.keys(noOver).length))
} catch (e) {
  console.log(`SKIP envConfigOverrides（schemastery/依赖不可用）— ${(e as Error).message}`)
}

// ── Skill 注册：source 必填回归（修复 "loaded skill source must be a string"）──
// 复刻 dsh-skill validateDefinition 的字段校验；缺失 source 会在模型加载时抛错。
{
  const { registerSkill } = await import('../src/knowledge/skill.ts')
  let captured: any = null
  registerSkill({ get: (name: string) => (name === 'skills' ? { register: (s: unknown) => { captured = s; return () => {} } } : undefined) }, { enabled: true })
  check('skill 已注册', captured !== null)
  if (captured) {
    check('skill source 为字符串（关键）', typeof captured.source === 'string', String(captured.source))
    check('skill content 为字符串', typeof captured.content === 'string', String(captured.content?.length))
    check('R4 SKILL content 无占位符残留', typeof captured.content === 'string' && !captured.content.includes('{{'), String(captured.content?.slice(0, 40)))
    check('R4 SKILL content 含阈值占位替换', typeof captured.content === 'string' && (captured.content.includes('51200') || captured.content.includes('{{maxReadDenyBytes}}') === false))
    check('skill description 非空', typeof captured.description === 'string' && captured.description.length > 0)
    check('skill name 合法 kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(captured.name), captured.name)
  }
}

// ── R1：安全 P0 修复回归 ──
{
  // R1-2（S-H2）SSRF 防护
  const bad = ['http://127.0.0.1:6379/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://[::1]/', 'http://[fe80::1]/', 'file:///etc/passwd', 'http://100.64.0.1/']
  const badRejected = bad.every((u) => { try { assertSafeUrl(u); return false } catch { return true } })
  check('R1 SSRF 拒绝内网/特殊地址', badRejected)
  let goodOk = false
  try { assertSafeUrl('https://example.com/a'); goodOk = true } catch { /* noop */ }
  check('R1 SSRF 放行公网域名', goodOk)
}
{
  // R1-3（S-H3）boundedWhitelist 默认值不含 cat/git
  try {
    const { DEFAULT_CONFIG } = await import('../src/config.ts')
    const wl = DEFAULT_CONFIG.boundedWhitelist
    check('R1 默认白名单不含 cat/git', !wl.includes('cat') && !wl.includes('git'), wl.join(','))
  } catch (e) {
    console.log(`SKIP R1 白名单默认值（schemastery 不可用）— ${(e as Error).message}`)
  }
}
{
  // R1-4（B-08）collectFiles：symlink 环不栈溢出、不跟随越界 symlink
  const dir = mkdtempSync(path.join(tmpdir(), 'ctx-smoke-'))
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'hello')
    symlinkSync(dir, path.join(dir, 'self')) // 自指环
    mkdirSync(path.join(dir, 'real'))
    writeFileSync(path.join(dir, 'real', 'b.txt'), 'world')
    symlinkSync('/etc', path.join(dir, 'escape')) // 越界 symlink
    const files = collectFiles([dir])
    check('R1 collectFiles symlink 环不栈溢出', files.length >= 1 && files.length < 20, `files=${files.length}`)
    check('R1 collectFiles 不跟随越界 symlink', !files.some((f) => f.includes('escape')), files.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── R2：正确性 P1 修复回归 ──
{
  const { byteLen } = await import('../src/util/bytes.ts')
  check('R2 byteLen CJK 1字=3字节', byteLen('中') === 3, String(byteLen('中')))
}
{
  // R2-1：searchChunks 字节预算（CJK snippet 按真实字节截断）
  const mem = new DatabaseSync(':memory:')
  createSchema(mem)
  addChunk(mem, 'r', '标题', '中文内容'.repeat(200), 86_400_000, Date.now())
  const hits = searchChunks(mem, { query: '中文', topN: 5, budgetBytes: 600 })
  const total = hits.reduce((a, h) => a + Buffer.byteLength(h.snippet, 'utf8'), 0)
  check('R2 searchChunks CJK 预算 ≤600 字节', total <= 600, `bytes=${total}`)
  mem.close()
}
{
  // R2-2/R2-3：readFloodDecision——信任文档去扩展名 + 有界 limit
  const cfg = {
    routingEnabled: true, autoGuideRead: true, readAllowBounded: true,
    maxReadBytesBeforeAsk: 51200, trustedReadBasenames: ['README', 'CHANGELOG', 'LICENSE', 'AGENTS', 'package.json'], trustedDocHeadroom: 4,
  }
  const stat = async () => 100_000
  const mk = (arguments_: any) => ({ name: 'read', arguments: arguments_ })
  const r1 = await readFloodDecision(mk({ file_path: '/x/README.md' }), cfg, stat)
  check('R2 信任文档 README.md 豁免（去扩展名）', r1 === undefined, String(r1?.reason ?? 'pass'))
  const r2 = await readFloodDecision(mk({ file_path: '/x/packaged.json' }), cfg, stat)
  check('R2 非信任 packaged.json deny', r2 !== undefined)
  const r3 = await readFloodDecision(mk({ file_path: '/x/big.log', offset: 0, limit: 100 }), cfg, stat)
  check('R2 有界 limit=100 放行', r3 === undefined)
  const r4 = await readFloodDecision(mk({ file_path: '/x/big.log', offset: 0, limit: 999999 }), cfg, stat)
  check('R2 超大 limit=999999 deny', r4 !== undefined, String(r4?.reason?.slice(0, 30)))
}

// ── R3：资源与健壮 P1.5 回归 ──
{
  // R3-2（B-08g）：FTS5 非法 query 转义重试，不静默丢表；合法 query 行为不变
  const mem = new DatabaseSync(':memory:')
  createSchema(mem)
  addChunk(mem, 'r', 't', 'alpha beta gamma', 86_400_000, Date.now())
  let noThrow = true
  try { searchChunks(mem, { query: 'alpha" OR (', topN: 3, budgetBytes: 1000 }) } catch { noThrow = false }
  check('R3 FTS5 非法 query 不抛错（转义重试）', noThrow)
  const ok = searchChunks(mem, { query: 'alpha', topN: 3, budgetBytes: 1000 })
  check('R3 合法 query 正常命中', ok.length === 1, `hits=${ok.length}`)
  mem.close()
}
{
  // R3-1（B-08e）：openKnowledgeDb 启用 WAL + busy_timeout
  const { openKnowledgeDb } = await import('../src/knowledge/sqlite.ts')
  const dir = mkdtempSync(path.join(tmpdir(), 'ctx-db-'))
  try {
    const k = openKnowledgeDb(dir)
    const jm = k.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    check('R3 openKnowledgeDb WAL', String(jm.journal_mode).toLowerCase() === 'wal', String(jm.journal_mode))
    const bt = k.db.prepare('PRAGMA busy_timeout').all() as { timeout: number }[]
    check('R3 openKnowledgeDb busy_timeout=5000', bt[0]?.timeout === 5000, JSON.stringify(bt))
    k.db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ── R5：收敛与诚实性 P2+ 回归 ──
{
  // R5-1（D-H3）：computeSavedBytes 口径拆分（measured 可证伪 / estimate 粗差）
  const { computeSavedBytes, incMeta } = await import('../src/knowledge/sqlite.ts')
  const mem = new DatabaseSync(':memory:')
  createSchema(mem)
  incMeta(mem, 'read_denied_bytes', 1000)
  incMeta(mem, 'denied_bytes', 200)
  incMeta(mem, 'indexed_bytes', 5000)
  incMeta(mem, 'search_bytes', 800)
  const m = computeSavedBytes(mem)
  check('R5 savedMeasured=read+cmd', m.savedMeasured === 1200, String(m.savedMeasured))
  check('R5 savedEstimate=indexed-search', m.savedEstimate === 4200, String(m.savedEstimate))
  check('R5 saved=measured+estimate', m.saved === 5400, String(m.saved))
  mem.close()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)