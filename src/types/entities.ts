export type GroupColor = 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'

export interface AppTab {
  id: number
  windowId: number
  index: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean
  pinned: boolean
  audible?: boolean
  muted?: boolean
  /** Chrome 140+ 原生分屏视图的 ID，未处于分屏时为 -1。扩展只能读，不能设置 */
  splitViewId?: number
  discarded: boolean
  lastAccessed: number
  groupId?: string
}

export interface VirtualGroup {
  id: string
  title: string
  color: GroupColor
  tabIds: number[]
  // 成员 URL，用于浏览器重启后标签 id 变化时按 URL 重新认领回原组
  tabUrls?: string[]
  collapsed: boolean
  source: 'ai' | 'manual' | 'domain'
  createdAt: number
}

export interface Session {
  id: string
  name: string
  createdAt: number
  tabs: Array<{ title: string; url: string; pinned: boolean }>
  groups: Array<{ title: string; color: GroupColor; source: VirtualGroup['source']; tabUrls: string[] }>
}

export interface AIGroupingCache {
  key: string
  result: Array<{ title: string; color: string; urls: string[] }>
  model: string
  createdAt: number
}

// 归档的标签。关掉但不丢，消除"关了就找不回来"的恐惧。
export interface StashedTab {
  id: string
  title: string
  url: string
  favIconUrl?: string
  stashedAt: number
  groupTitle?: string
  auto: boolean
}

// 分组规则：命中的标签不送给 AI，既省 token 又让结果可控
export interface GroupingRule {
  id: string
  pattern: string
  title: string
  color: GroupColor
}

export interface AppConfig {
  ai: { baseURL: string; apiKey: string; model: string; enabled: boolean; customPrompt: string }
  grouping: { autoThreshold: number; throttleMs: number; rules: GroupingRule[] }
  suspend: { enabled: boolean; idleMinutes: number; whitelist: string[] }
  stash: { autoEnabled: boolean; autoDays: number }
  ui: { theme: 'dark' | 'light' | 'system'; density: 'comfortable' | 'compact' }
}
