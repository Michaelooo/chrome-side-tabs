import { storage } from '../lib/storage'
import { queryTabsInWindow } from '../lib/tab-manager'
import { provenance } from '../lib/provenance'
import { logger } from '../lib/logger'
import type { AppTab } from '../types/entities'

export function initTabWatcher() {
  chrome.tabs.onCreated.addListener(tab => {
    // 记录来源链路：openerTabId 只在 onCreated 这一刻拿得到
    provenance.record(tab).catch(err => logger.warn('Failed to record tab origin', err))
    refreshCurrentWindow()
  })
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
      refreshCurrentWindow()
    }
  })
  chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
    provenance.forget(tabId).catch(err => logger.warn('Failed to forget tab origin', err))
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
