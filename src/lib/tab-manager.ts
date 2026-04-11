import type { AppTab } from '../types/entities'

function chromeTabToAppTab(tab: chrome.tabs.Tab): AppTab {
  return {
    id: tab.id!,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title ?? '',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    discarded: tab.discarded ?? false,
    lastAccessed: tab.lastAccessed ?? Date.now(),
  }
}

export async function queryTabsInWindow(windowId: number): Promise<AppTab[]> {
  const tabs = await chrome.tabs.query({ windowId })
  return tabs.filter(t => t.id != null).map(chromeTabToAppTab)
}

export async function activateTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true })
}

export async function closeTab(tabId: number): Promise<void> {
  await chrome.tabs.remove(tabId)
}

export async function pinTab(tabId: number, pinned: boolean): Promise<void> {
  await chrome.tabs.update(tabId, { pinned })
}

export async function discardTab(tabId: number): Promise<void> {
  await chrome.tabs.discard(tabId)
}

export async function createTab(url?: string): Promise<void> {
  await chrome.tabs.create({ url: url ?? 'chrome://newtab' })
}

export async function getAllWindows(): Promise<chrome.windows.Window[]> {
  return chrome.windows.getAll({ windowTypes: ['normal'] })
}

export async function getCurrentWindow(): Promise<chrome.windows.Window> {
  return chrome.windows.getCurrent()
}
