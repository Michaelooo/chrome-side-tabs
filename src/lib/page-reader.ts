export interface PageContent {
  tabId: number
  title: string
  url: string
  text: string
  truncated: boolean
  wasDiscarded: boolean
  error?: string
}

// 每页正文上限。中文场景下字符数约等于 token 数，
// 4 页 × 4000 字已经是一次不小的请求，再大响应会明显变慢。
const MAX_CHARS_PER_PAGE = 4000
export const MAX_READ_TABS = 4

/**
 * 注入页面执行的正文提取。必须自包含，不能引用外部作用域。
 * 在 clone 上做清理而不是直接读 innerText——innerText 会强制 layout，
 * textContent 不会。
 */
function extractReadableText(maxChars: number): { text: string; truncated: boolean } {
  const root =
    document.querySelector('article') ??
    document.querySelector('main') ??
    document.body
  if (!root) return { text: '', truncated: false }

  const clone = root.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll('script,style,noscript,svg,canvas,nav,header,footer,aside,iframe,form,button,[aria-hidden="true"]')
    .forEach(el => el.remove())

  let text = (clone.textContent ?? '')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const meta = document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim()
  if (meta && !text.includes(meta)) text = meta + '\n\n' + text

  return { text: text.slice(0, maxChars), truncated: text.length > maxChars }
}

async function waitForComplete(tabId: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return
    } catch {
      return
    }
    await new Promise(r => setTimeout(r, 300))
  }
}

/** 批量读取标签正文。已休眠的标签会被唤醒（重新加载）后再读。 */
export async function readPages(tabIds: number[]): Promise<PageContent[]> {
  const out: PageContent[] = []

  for (const tabId of tabIds.slice(0, MAX_READ_TABS)) {
    let tab: chrome.tabs.Tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      continue
    }

    const base = {
      tabId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      wasDiscarded: tab.discarded ?? false,
    }

    if (!/^https?:|^file:/i.test(tab.url ?? '')) {
      out.push({ ...base, text: '', truncated: false, error: '浏览器内置页，无法读取' })
      continue
    }

    // 休眠标签没有活的 DOM，注入会失败，先唤醒
    if (tab.discarded) {
      try {
        await chrome.tabs.reload(tabId)
        await waitForComplete(tabId)
      } catch { /* 唤醒失败就让注入自己报错 */ }
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractReadableText,
        args: [MAX_CHARS_PER_PAGE],
      })
      const r = results[0]?.result as { text: string; truncated: boolean } | undefined
      if (!r?.text) {
        out.push({ ...base, text: '', truncated: false, error: '页面没有可读文本' })
      } else {
        out.push({ ...base, ...r })
      }
    } catch (err) {
      out.push({ ...base, text: '', truncated: false, error: (err as Error).message })
    }
  }

  return out
}
