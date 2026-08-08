import { logger } from '../lib/logger'

// 工具栏图标上的徽标。它不是状态显示器，是行动信号——
// 未分组标签少的时候没什么可做的，常年挂个数字只会变成背景噪音，
// 多到这个数才值得提醒一句「该整理了」。
const BADGE_MIN = 8

export async function refreshBadge(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true })
    const ungrouped = tabs.filter(t =>
      !t.pinned && t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE,
    ).length
    await chrome.action.setBadgeText({ text: ungrouped >= BADGE_MIN ? String(ungrouped) : '' })
  } catch (err) {
    logger.warn('Failed to refresh badge', err)
  }
}

export function initBadge() {
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' })
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' })

  // 标签事件已经由 tab-watcher 的 refreshWindow 带着刷新，
  // 这里只补它没覆盖的：分组本身的增删改会直接改变未分组数量
  const groupEvents = [
    chrome.tabGroups.onCreated,
    chrome.tabGroups.onUpdated,
    chrome.tabGroups.onRemoved,
  ]
  groupEvents.forEach(e => e.addListener(() => { refreshBadge() }))
  chrome.windows.onFocusChanged.addListener(() => { refreshBadge() })

  refreshBadge()
}
