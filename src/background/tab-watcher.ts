import { storage } from '../lib/storage'
import { queryTabsInWindow } from '../lib/tab-manager'
import { logger } from '../lib/logger'
import type { AppTab } from '../types/entities'

export function initTabWatcher() {
  chrome.tabs.onCreated.addListener(() => refreshCurrentWindow())
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
      refreshCurrentWindow()
    }
  })
  chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
    refreshWindow(windowId)
  })
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    refreshWindow(windowId)
  })
  chrome.tabs.onMoved.addListener((_, { windowId }) => {
    refreshWindow(windowId)
  })
  chrome.tabs.onDetached.addListener((_, { oldWindowId }) => {
    refreshWindow(oldWindowId)
  })
  chrome.tabs.onAttached.addListener((_, { newWindowId }) => {
    refreshWindow(newWindowId)
  })
  logger.info('Tab watcher initialized')
}

export async function refreshCurrentWindow() {
  const win = await chrome.windows.getCurrent()
  if (win.id) await refreshWindow(win.id)
}

export async function refreshWindow(windowId: number) {
  try {
    const tabs = await queryTabsInWindow(windowId)
    await storage.tabsSnapshot.set(windowId, tabs)
    logger.info(`Refreshed ${tabs.length} tabs for window ${windowId}`)
  } catch (err) {
    logger.error('Failed to refresh window', windowId, err)
  }
}
