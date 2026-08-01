import type { AppTab } from '../types/entities'

// 一个标签的来源记录。openerTitle/openerUrl 在创建那一刻就快照下来，
// 这样即使来源标签后来被关掉，仍然能告诉用户"这是从哪儿点开的"。
export interface TabOrigin {
  tabId: number
  openerTabId?: number
  openerTitle?: string
  openerUrl?: string
  createdAt: number
}

const KEY = 'tab_origins'

// 存在 chrome.storage.session：生命周期和 tabId 一致，浏览器重启后一起失效，
// 不会留下指向已失效 id 的脏数据。
async function readAll(): Promise<Record<number, TabOrigin>> {
  const result = await chrome.storage.session.get(KEY)
  return (result[KEY] as Record<number, TabOrigin>) ?? {}
}

async function writeAll(map: Record<number, TabOrigin>): Promise<void> {
  await chrome.storage.session.set({ [KEY]: map })
}

export const provenance = {
  getAll: readAll,

  async record(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id == null) return
    const map = await readAll()
    const entry: TabOrigin = { tabId: tab.id, createdAt: Date.now() }

    if (tab.openerTabId != null) {
      entry.openerTabId = tab.openerTabId
      try {
        const opener = await chrome.tabs.get(tab.openerTabId)
        entry.openerTitle = opener.title
        entry.openerUrl = opener.url
      } catch {
        // 来源标签已经没了，只保留 id
      }
    }

    map[tab.id] = entry
    await writeAll(map)
  },

  async forget(tabId: number): Promise<void> {
    const map = await readAll()
    if (!(tabId in map)) return
    delete map[tabId]
    await writeAll(map)
  },
}

export interface TabNode {
  tab: AppTab
  depth: number
  origin?: TabOrigin
  children: TabNode[]
}

/**
 * 按 openerTabId 把标签串成树。
 * - 来源标签已关闭的，自己升为根节点（但仍保留 origin 里的来源标题）
 * - 有环时按先到先得断开，避免死循环
 */
export function buildTabTree(tabs: AppTab[], origins: Record<number, TabOrigin>): TabNode[] {
  const nodes = new Map<number, TabNode>()
  for (const tab of tabs) {
    nodes.set(tab.id, { tab, depth: 0, origin: origins[tab.id], children: [] })
  }

  const roots: TabNode[] = []
  for (const tab of tabs) {
    const node = nodes.get(tab.id)!
    const openerId = origins[tab.id]?.openerTabId
    const parent = openerId != null ? nodes.get(openerId) : undefined

    if (parent && parent !== node && !isDescendant(parent, node)) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // 深度在挂完树之后统一算，顺便保证子节点按标签顺序排列
  const assignDepth = (node: TabNode, depth: number) => {
    node.depth = depth
    node.children.sort((a, b) => a.tab.index - b.tab.index)
    for (const child of node.children) assignDepth(child, depth + 1)
  }
  roots.sort((a, b) => a.tab.index - b.tab.index)
  for (const root of roots) assignDepth(root, 0)

  return roots
}

function isDescendant(candidate: TabNode, ancestor: TabNode): boolean {
  for (const child of ancestor.children) {
    if (child === candidate || isDescendant(candidate, child)) return true
  }
  return false
}

// 把树摊平成渲染用的线性列表，同时支持按节点折叠
export function flattenTree(roots: TabNode[], collapsed: Set<number>): TabNode[] {
  const out: TabNode[] = []
  const walk = (node: TabNode) => {
    out.push(node)
    if (collapsed.has(node.tab.id)) return
    for (const child of node.children) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

// 收集一个节点及其所有后代的 tabId，用于"关闭整条链路"
export function collectSubtreeIds(node: TabNode): number[] {
  const out = [node.tab.id]
  for (const child of node.children) out.push(...collectSubtreeIds(child))
  return out
}
