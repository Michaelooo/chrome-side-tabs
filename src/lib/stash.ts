import type { AppTab, StashedTab } from '../types/entities'

const KEY = 'stash'
const MAX_ENTRIES = 800

async function readAll(): Promise<StashedTab[]> {
  const result = await chrome.storage.local.get(KEY)
  return (result[KEY] as StashedTab[]) ?? []
}

async function writeAll(list: StashedTab[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: list })
}

function makeId(): string {
  return `stash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface StashInput {
  title: string
  url: string
  favIconUrl?: string
  groupTitle?: string
}

export const stash = {
  list: readAll,

  async count(): Promise<number> {
    return (await readAll()).length
  },

  /**
   * 归档一批标签。同一个 URL 只保留最新的一条，避免反复归档同一个页面刷屏。
   * 返回实际写入的条数。
   */
  async add(items: StashInput[], auto = false): Promise<number> {
    if (items.length === 0) return 0
    const existing = await readAll()
    const incomingUrls = new Set(items.map(i => i.url))
    const kept = existing.filter(e => !incomingUrls.has(e.url))

    const now = Date.now()
    const added: StashedTab[] = items.map(i => ({
      id: makeId(),
      title: i.title || i.url,
      url: i.url,
      favIconUrl: i.favIconUrl,
      groupTitle: i.groupTitle,
      stashedAt: now,
      auto,
    }))

    const next = [...added, ...kept]
    if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES
    await writeAll(next)
    return added.length
  },

  async remove(ids: string[]): Promise<void> {
    const idSet = new Set(ids)
    await writeAll((await readAll()).filter(e => !idSet.has(e.id)))
  },

  async clear(): Promise<void> {
    await writeAll([])
  },

  /** 恢复：重新打开这些页面，并把它们从归档里移除 */
  async restore(ids: string[]): Promise<void> {
    const idSet = new Set(ids)
    const all = await readAll()
    const targets = all.filter(e => idSet.has(e.id))
    for (const t of targets) {
      try {
        await chrome.tabs.create({ url: t.url, active: false })
      } catch {
        // URL 可能已不合法，跳过但仍然从归档移除
      }
    }
    await writeAll(all.filter(e => !idSet.has(e.id)))
  },
}

/** 归档并关闭。先写存储再关标签，写失败就不关，避免丢页面。 */
export async function stashAndClose(tabs: AppTab[], groupTitle?: string): Promise<number> {
  const items = tabs
    .filter(t => t.url && !t.url.startsWith('chrome://'))
    .map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl, groupTitle }))
  if (items.length === 0) return 0

  const added = await stash.add(items)
  const ids = tabs.map(t => t.id)
  if (ids.length > 0) await chrome.tabs.remove(ids)
  return added
}

export function toMarkdown(items: StashedTab[]): string {
  const byGroup = new Map<string, StashedTab[]>()
  for (const item of items) {
    const key = item.groupTitle || '未分组'
    const list = byGroup.get(key) ?? []
    list.push(item)
    byGroup.set(key, list)
  }

  const lines: string[] = [`# 归档标签（${items.length}）`, '']
  for (const [group, list] of byGroup) {
    lines.push(`## ${group}`, '')
    for (const item of list) {
      lines.push(`- [${item.title.replace(/[[\]]/g, '')}](${item.url})`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function formatStashedAt(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}
