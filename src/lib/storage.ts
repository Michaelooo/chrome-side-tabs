import type { AppConfig, Session, AIGroupingCache, VirtualGroup } from '../types/entities'

const KEYS = {
  config: 'config',
  sessions: 'sessions',
  aiCache: 'ai_cache',
  groups: 'groups',
  tabsSnapshot: 'tabs_snapshot',
} as const

const DEFAULT_CONFIG: AppConfig = {
  ai: { baseURL: '', apiKey: '', model: 'deepseek-chat', enabled: false, customPrompt: '' },
  grouping: { autoThreshold: 10, throttleMs: 30000 },
  suspend: { enabled: false, idleMinutes: 30, whitelist: [] },
  ui: { theme: 'dark', density: 'comfortable' },
}

// 通用 get/set for chrome.storage.local
async function localGet<T>(key: string): Promise<T | null> {
  const result = await chrome.storage.local.get(key)
  return (result[key] as T) ?? null
}

async function localSet<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

// 通用 get/set for chrome.storage.session
async function sessionGet<T>(key: string): Promise<T | null> {
  const result = await chrome.storage.session.get(key)
  return (result[key] as T) ?? null
}

async function sessionSet<T>(key: string, value: T): Promise<void> {
  await chrome.storage.session.set({ [key]: value })
}

export const storage = {
  config: {
    get: () => localGet<AppConfig>(KEYS.config).then(c => c ?? { ...DEFAULT_CONFIG }),
    set: (partial: Partial<AppConfig>) =>
      storage.config.get().then(current => localSet(KEYS.config, { ...current, ...partial })),
  },
  sessions: {
    list: () => localGet<Session[]>(KEYS.sessions).then(s => s ?? []),
    add: (session: Session) =>
      storage.sessions.list().then(list => localSet(KEYS.sessions, [...list, session])),
    remove: (id: string) =>
      storage.sessions.list().then(list => localSet(KEYS.sessions, list.filter(s => s.id !== id))),
  },
  aiCache: {
    get: (key: string) =>
      localGet<AIGroupingCache[]>(KEYS.aiCache).then(cache => {
        const entry = (cache ?? []).find(c => c.key === key)
        return entry ?? null
      }),
    put: (entry: AIGroupingCache) =>
      localGet<AIGroupingCache[]>(KEYS.aiCache).then(cache => {
        const list = (cache ?? []).filter(c => c.key !== entry.key)
        list.unshift(entry)
        if (list.length > 50) list.length = 50 // LRU cap
        return localSet(KEYS.aiCache, list)
      }),
  },
  groups: {
    get: (windowId: number) =>
      localGet<Record<number, VirtualGroup[]>>(KEYS.groups).then(g => g?.[windowId] ?? []),
    set: (windowId: number, groups: VirtualGroup[]) =>
      localGet<Record<number, VirtualGroup[]>>(KEYS.groups).then(all => {
        const map = all ?? {}
        map[windowId] = groups
        return localSet(KEYS.groups, map)
      }),
  },
  tabsSnapshot: {
    get: (windowId: number) =>
      sessionGet<Record<number, unknown>>(KEYS.tabsSnapshot).then(m => m?.[windowId] ?? null),
    set: (windowId: number, tabs: unknown) =>
      sessionGet<Record<number, unknown>>(KEYS.tabsSnapshot).then(map => {
        const m = map ?? {}
        m[windowId] = tabs
        return sessionSet(KEYS.tabsSnapshot, m)
      }),
  },
}
