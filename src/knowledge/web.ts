// knowledge/web.ts — URL → markdown：Node 全局 fetch（不依赖 ctx.web，其默认无 provider）
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

export interface UrlMarkdown { title: string; markdown: string }

/** 抓取一个 URL 并转 markdown。失败抛错（含超时/非 2xx）。 */
export async function urlToMarkdown(url: string, timeoutMs = 30000): Promise<UrlMarkdown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    const raw = await res.text()
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
