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
  discarded: boolean
  lastAccessed: number
  groupId?: string
}

export interface VirtualGroup {
  id: string
  title: string
  color: GroupColor
  tabIds: number[]
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

export interface AppConfig {
  ai: { baseURL: string; apiKey: string; model: string; enabled: boolean; customPrompt: string }
  grouping: { autoThreshold: number; throttleMs: number }
  suspend: { enabled: boolean; idleMinutes: number; whitelist: string[] }
  ui: { theme: 'dark' | 'light' | 'system'; density: 'comfortable' | 'compact' }
}
