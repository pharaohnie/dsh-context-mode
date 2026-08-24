// knowledge/web.ts — URL → markdown：Node 全局 fetch（不依赖 ctx.web，其默认无 provider）
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

export interface UrlMarkdown { title: string; markdown: string }

/** R1-2（S-H2）SSRF 防护：仅 http/https，拒绝 loopback/私网/链路本地/云元数据/CGNAT（含 IPv6）。
 *  域名不做 DNS 解析后校验（FIX-PLAN 决策点 F2 默认否，残留面已注释声明）。 */
export function assertSafeUrl(url: string): void {
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`context-mode: URL 非法 ${url}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`context-mode: 仅允许 http/https，收到 ${u.protocol}`)
  }
  const host = u.hostname.toLowerCase()
  const ipv4 = host.replace(/^\[|\]$/g, '')
  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(ipv4)
  const isIpv6 = host.includes(':')
  const blocked =
    host === 'localhost' || ipv4 === '0.0.0.0' || ipv4 === '::1'
    || (isIpv6 && (ipv4.startsWith('fe80:') || ipv4.startsWith('fc') || ipv4.startsWith('fd')))
    || (isIpv4 && (() => {
      const [a, b] = ipv4.split('.').map(Number)
      if (a === 10 || a === 127) return true
      if (a === 169 && b === 254) return true // 云元数据 169.254.169.254
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
      if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
      return false
    })())
  if (blocked) throw new Error(`context-mode: 拒绝抓取内网/特殊地址 ${host}（SSRF 防护）`)
}

/** 抓取一个 URL 并转 markdown。失败抛错（含超时/非 2xx/超限/SSRF 拒绝）。redirect: manual 逐跳校验 Location。 */
export async function urlToMarkdown(url: string, timeoutMs = 30000): Promise<UrlMarkdown> {
  assertSafeUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let current = url
    let res = await fetch(current, { signal: controller.signal, redirect: 'manual' })
    let redirects = 0
    while (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (++redirects > 5) throw new Error(`context-mode: 重定向次数超限 ${url}`)
      current = new URL(res.headers.get('location')!, current).toString()
      assertSafeUrl(current)
      res = await fetch(current, { signal: controller.signal, redirect: 'manual' })
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    const cl = Number(res.headers.get('content-length') ?? 0)
    if (cl > 5_000_000) throw new Error(`context-mode: 页面过大（content-length ${cl} > 5MB）已放弃抓取 ${url}`)
    const raw = await res.text()
    if (Buffer.byteLength(raw, 'utf8') > 5_000_000) {
      throw new Error(`context-mode: 页面过大（>5MB）已放弃抓取 ${url}`)
    }
    // 剥掉 <style>/<script> 块，避免样式/脚本原文进入索引
    const html = raw.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    td.use(gfm)
    const markdown = td.turndown(html)
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? new URL(url).hostname).trim()
    return { title, markdown }
  } finally {
    clearTimeout(timer)
  }
}

/** 简单并发池：并发执行 tasks，上限 concurrency（1-8）。 */
export async function concurrencyPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const lim = Math.max(1, Math.min(8, concurrency))
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const i = cursor++
      await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(lim, items.length) }, run))
}
