import type { AppTab, VirtualGroup } from '../types/entities'

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

// chrome 类型要求 tabIds 为非空元组，调用前均已判空
const asTabIds = (ids: number[]) => ids as [number, ...number[]]

// 将虚拟分组同步到 Chrome 原生标签组，按 title 做增量 diff
export async function applyGroupsToBrowser(windowId: number, groups: VirtualGroup[]): Promise<void> {
  const tabsInWindow = await chrome.tabs.query({ windowId })

  // 可分组的有效 tabId（排除已关闭、pinned），并记录每个 tab 当前所属原生组
  const groupableIds = new Set<number>()
  const tabGroupId = new Map<number, number>()
  for (const t of tabsInWindow) {
    if (t.id == null) continue
    if (!t.pinned) groupableIds.add(t.id)
    if (t.groupId != null && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      tabGroupId.set(t.id, t.groupId)
    }
  }

  // 当前原生组：按 title 建索引，并收集每组成员
  const nativeGroups = await chrome.tabGroups.query({ windowId })
  const nativeByTitle = new Map<string, chrome.tabGroups.TabGroup>()
  for (const g of nativeGroups) {
    if (g.title) nativeByTitle.set(g.title, g)
  }
  const nativeMembers = new Map<number, number[]>()
  for (const [tabId, gid] of tabGroupId) {
    const list = nativeMembers.get(gid) ?? []
    list.push(tabId)
    nativeMembers.set(gid, list)
  }

  const matchedGroupIds = new Set<number>()

  for (const vg of groups) {
    const desired = vg.tabIds.filter(id => groupableIds.has(id))
    if (desired.length === 0) continue

    const existing = nativeByTitle.get(vg.title)
    if (existing) {
      matchedGroupIds.add(existing.id)
      const current = nativeMembers.get(existing.id) ?? []
      const toAdd = desired.filter(id => tabGroupId.get(id) !== existing.id)
      const toRemove = current.filter(id => !desired.includes(id))
      if (toAdd.length) await chrome.tabs.group({ groupId: existing.id, tabIds: asTabIds(toAdd) })
      if (toRemove.length) await chrome.tabs.ungroup(asTabIds(toRemove))
      if (existing.color !== vg.color || existing.collapsed !== vg.collapsed) {
        await chrome.tabGroups.update(existing.id, { color: vg.color, collapsed: vg.collapsed })
      }
    } else {
      const groupId = await chrome.tabs.group({ tabIds: asTabIds(desired), createProperties: { windowId } })
      await chrome.tabGroups.update(groupId, {
        title: vg.title,
        color: vg.color,
        collapsed: vg.collapsed,
      })
    }
  }

  // 解散未被任何虚拟分组匹配的原生组
  for (const g of nativeGroups) {
    if (matchedGroupIds.has(g.id)) continue
    const members = nativeMembers.get(g.id)
    if (members && members.length) await chrome.tabs.ungroup(asTabIds(members))
  }
}
