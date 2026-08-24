// util/shell-tokenize.ts — 识别 shell 命令中的洪水工具（curl/wget/inline-fetch）
// 加固：处理重定向目标、env 赋值、前缀带参、路径 basename、`bash -c` 递归、多命令段。
// 用法：floodCommandWord('sudo -u bob curl x') -> 'curl'；floodCommandWord('echo "curl"') -> ''
const OP_SPLIT = /[\n;|&]+/ // 命令分隔符（分段，逐段识别）
const PREFIXES = ['sudo', 'env', 'command', 'nohup', 'time', 'exec'] // 透明前缀
const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh']
const VALUE_OPTS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-c', '-o', '-n', '-l', '-r', '-w', '-P', '-S', '-H']) // 带值选项
export const FLOOD_WORDS = ['curl', 'wget', 'inline-fetch']

const REDIRECT = /^(?:[0-9]+)?(?:>>|>&|<<|<&|&>>|&>|>|<)$/ // 单 token 重定向运算符
const REDIRECT_ATTACHED = /^(?:[0-9]+)?(?:>>|>&|<<|<&|&>>|&>|>|<)(?:"[^"]*"|'[^']*'|\S+)$/ // 运算符+目标紧贴（如 2>/dev/null）
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)?$/

function tokenize(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
}
const stripQuotes = (t: string) => t.replace(/^["']|["']$/g, '')

/** 判断一个 token 是否为「运算符+目标紧贴」的重定向（如 2>/dev/null、>out.txt）。 */
function isAttachedRedir(t: string): boolean {
  return REDIRECT_ATTACHED.test(t) && !ENV_ASSIGN.test(t)
}

/** 取单个命令段的有效命令词（小写，路径取 basename）。 */
export function commandWordOf(segment: string): string {
  const toks = tokenize(segment)
  let i = 0
  let prefix = false
  let command: string | null = null
  while (i < toks.length) {
    const clean = stripQuotes(toks[i])
    // 重定向运算符（独立 token）：跳过它 + 目标 token
    if (REDIRECT.test(clean)) { i += 2; continue }
    // 重定向运算符+目标紧贴（如 2>/dev/null、>out.txt）：整体跳过
    if (isAttachedRedir(toks[i])) { i += 1; continue }
    // env 赋值
    if (ENV_ASSIGN.test(clean)) { i += 1; continue }
    // 透明前缀：进入前缀参数模式
    if (PREFIXES.includes(clean.toLowerCase()) && !prefix) { prefix = true; i += 1; continue }
    if (prefix) {
      // 选项：跳过；带值选项再跳过其值
      if (/^--?[A-Za-z0-9]/.test(clean) && !VALUE_OPTS.has(clean)) { i += 1; continue }
      if (VALUE_OPTS.has(clean)) { i += 2; continue }
      command = clean; i += 1; break
    }
    command = clean; i += 1; break
  }
  if (!command) return ''
  // 路径 -> basename
  let base = command.replace(/\\/g, '/').split('/').pop() ?? command
  base = base.toLowerCase()
  // shell -c：递归解析脚本
  if (SHELLS.includes(base)) {
    for (let j = 0; j < toks.length; j++) {
      if (stripQuotes(toks[j]) === '-c' && toks[j + 1] !== undefined) {
        const script = stripQuotes(toks[j + 1])
        return floodCommandWord(script)
      }
    }
  }
  return base
}

/** 扫描所有命令段，返回命中的洪水词；无则返回 ''。 */
export function floodCommandWord(command: string): string {
  if (!command) return ''
  for (const seg of command.split(OP_SPLIT)) {
    if (seg.trim() === '') continue
    const w = commandWordOf(seg)
    if (FLOOD_WORDS.includes(w)) return w
  }
  return ''
}

/** 兼容接口：首个命令段的命令词（小写）。 */
export function firstCommandWord(command: string): string {
  if (!command) return ''
  for (const seg of command.split(OP_SPLIT)) {
    if (seg.trim() === '') continue
    return commandWordOf(seg)
  }
  return ''
}

/** 是否包含 shell 控制运算符（管道/分号/&&/||/重定向/子shell/后台/命令替换等）。
 *  用于「结构性有界」判定：一个含控制运算符的命令不是「单命令」，不属于可安全放行的无害白名单。
 *  引号语义：单引号内全部字面量（跳过）；双引号内普通字符跳过，但**命令替换 `$(` 与反引号仍生效**，须检测。
 *  保守取向：宁可多判一个「有控制」，也不放行一个含命令替换的命令（安全基线偏严）。 */
export function hasShellControlOps(command: string): boolean {
  if (!command) return false
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\') { i++; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle) continue // 单引号内全字面量
    // 双引号内命令替换仍执行；单/双引号外普通控制运算符
    if (inDouble) {
      if (ch === '$' && command[i + 1] === '(') return true
      if (ch === '`') return true
      continue
    }
    if ('|;&<>`$(){}*?[]'.includes(ch)) return true
  }
  return false
}
