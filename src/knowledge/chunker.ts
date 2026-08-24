// knowledge/chunker.ts — markdown 分块：按标题切分、保留代码块文本、尺寸上限
export interface Chunk { title: string; body: string }

const HEADING = /^(#{1,2})\s+(.*)$/
const FENCE = /^```/

/** 按标题（#/##）切分 markdown，超过 maxBytes 的块在行边界二次切分。
 *  maxBytes 是分块粒度常数（默认 8000），与检索预算 SEARCH_BUDGET_BYTES(12000) 是两件事——
 *  前者控制单块大小（入库粒度），后者控制 ctx_search 返回的片断总预算；如需对齐请显式改这一处与 tools.ts 的常量。 */
export function chunkMarkdown(text: string, maxBytes = 8000): Chunk[] {
  const lines = text.split('\n')
  const chunks: Chunk[] = []
  let title = '(文档)'
  let buf: string[] = []
  let inFence = false
  const emit = () => {
    const b = buf.join('\n').trim()
    buf = []
    if (b.length === 0) return
    const pushBlock = (s: string) => chunks.push({ title, body: s })
    if (b.length <= maxBytes) { pushBlock(b); return }
    // 超限：先按行边界切；单段超长行则按词边界（无空格硬切）切成 <= maxBytes 的片
    let cur = ''
    for (const seg of b.split('\n')) {
      if (seg.length > maxBytes) {
        if (cur) { pushBlock(cur); cur = '' }
        let rest = seg
        while (rest.length > maxBytes) {
          const cut = rest.lastIndexOf(' ', maxBytes)
          const boundary = cut > maxBytes * 0.5 ? cut : maxBytes
          pushBlock(rest.slice(0, boundary).trimEnd())
          rest = rest.slice(boundary).trimStart()
        }
        cur = rest
        continue
      }
      if (cur.length > 0 && cur.length + seg.length + 1 > maxBytes) { pushBlock(cur); cur = seg }
      else cur = cur.length > 0 ? cur + '\n' + seg : seg
    }
    if (cur.length > 0) pushBlock(cur)
  }
  for (const ln of lines) {
    if (FENCE.test(ln)) inFence = !inFence
    const m = HEADING.exec(ln)
    if (m && !inFence) { emit(); title = `${m[1]} ${m[2]}`; continue }
    buf.push(ln)
  }
  emit()
  return chunks
}
