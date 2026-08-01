// chrome.sessions：找回误关的标签。归档抽屉管"有意关的"，这里管"手滑关的"。
// 需要可选权限 sessions，用到时才申请。

export interface ClosedItem {
  sessionId: string
  title: string
  url?: string
  isWindow: boolean
  tabCount: number
  closedAt: number
}

export async function listRecentlyClosed(max = 25): Promise<ClosedItem[]> {
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: max })
  const out: ClosedItem[] = []
  for (const s of sessions) {
    // lastModified 是秒级时间戳
    const closedAt = (s.lastModified ?? 0) * 1000
    if (s.tab?.sessionId) {
      out.push({
        sessionId: s.tab.sessionId,
        title: s.tab.title || s.tab.url || '无标题',
        url: s.tab.url,
        isWindow: false,
        tabCount: 1,
        closedAt,
      })
    } else if (s.window?.sessionId) {
      const tabs = s.window.tabs ?? []
      out.push({
        sessionId: s.window.sessionId,
        title: `整个窗口（${tabs.length} 个标签）`,
        isWindow: true,
        tabCount: tabs.length,
        closedAt,
      })
    }
  }
  return out
}

export async function restoreSessionId(sessionId: string): Promise<boolean> {
  try {
    await chrome.sessions.restore(sessionId)
    return true
  } catch {
    // sessionId 过期（列表刷新后旧 id 失效）是常见情况
    return false
  }
}
