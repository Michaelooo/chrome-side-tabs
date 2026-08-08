import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import type { CleanupCandidateInput, CleanupDecision } from './ai-client'
import { planGroups, classifyTabsForCleanup } from './ai-client'
import { applyGroupsToBrowser } from './tab-manager'
import { storage } from './storage'

// 侧栏和浮球面板共用的编排层：都要「整理分组 / 建组 / 挑清理候选」，
// 但各自持有自己的 React state，所以这里只做不依赖 UI 的那一半。
// windowId 由调用方传入——侧栏和嵌在网页里的浮球面板，解析当前窗口的方式不同。

export interface CleanupItem extends CleanupCandidateInput {
  decision: CleanupDecision['decision']
  aiReason: string
  selected: boolean
}

export interface GroupingResult {
  groups: VirtualGroup[]
  /** AI 没配置，groups 为空，调用方应把用户引到设置页 */
  notConfigured?: boolean
  /** 降级说明。groups 仍然有效，已落盘，只是没走 AI */
  warning?: string
  /** 硬失败。groups 为空且没有落盘，调用方应保持原有分组不动 */
  error?: string
}

function isNewTabUrl(url: string) {
  return url === 'chrome://newtab/' || url === 'chrome://newtab' || url === 'about:blank'
}

// 同步失败不该影响主流程：虚拟分组已经存下来了，原生标签组下次再对齐
async function syncToBrowser(windowId: number, groups: VirtualGroup[]) {
  try {
    await applyGroupsToBrowser(windowId, groups)
  } catch (err) {
    console.error('[SideTabs] Failed to sync groups to browser:', err)
  }
}

/**
 * 读回持久化的分组，并把成员重连到当前存活的标签上。
 * 先按 id 保留存活标签，再按 URL 认领重启后换了 id 的标签
 * （标签被 Chrome 冻结或浏览器重开后 tab id 会变，URL 不变）。
 */
export async function loadGroups(windowId: number): Promise<VirtualGroup[]> {
  const saved = await storage.groups.get(windowId)
  if (saved.length === 0) return []

  const liveTabs = await chrome.tabs.query({ windowId })
  const liveIds = new Set(liveTabs.map(t => t.id))
  const claimed = new Set<number>()
  const cleaned = saved
    .map(g => {
      const ids: number[] = []
      for (const id of g.tabIds) {
        if (liveIds.has(id) && !claimed.has(id)) { ids.push(id); claimed.add(id) }
      }
      if (g.tabUrls?.length) {
        const urlSet = new Set(g.tabUrls)
        for (const t of liveTabs) {
          if (t.id != null && !claimed.has(t.id) && t.url && urlSet.has(t.url)) {
            ids.push(t.id); claimed.add(t.id)
          }
        }
      }
      return { ...g, tabIds: ids }
    })
    .filter(g => g.tabIds.length > 0)

  if (cleaned.length > 0) await storage.groups.set(windowId, cleaned)
  return cleaned
}

/** 规则先行 → 复用缓存 → 只把没见过的标签送给 AI → 失败时本地聚类兜底 */
export async function runGrouping(
  tabs: AppTab[],
  windowId: number,
  opts: { forceRefresh?: boolean } = {},
): Promise<GroupingResult> {
  if (tabs.length < 2) return { groups: [] }

  try {
    const config = await storage.config.get()
    if (!config.ai.apiKey || !config.ai.baseURL) return { groups: [], notConfigured: true }

    const tabInputs = tabs.map((t, i) => ({ index: i, title: t.title, url: t.url }))
    const plan = await planGroups(tabInputs, config, opts)

    // URL 可能对应多个标签，按 URL 回填 tabId 时要保证一个标签只进一个组
    const urlToIds = new Map<string, number[]>()
    for (const t of tabs) {
      const list = urlToIds.get(t.url) ?? []
      list.push(t.id)
      urlToIds.set(t.url, list)
    }
    const used = new Set<number>()

    const groups: VirtualGroup[] = plan.groups
      .map((g, i) => {
        const ids: number[] = []
        for (const url of g.urls) {
          for (const id of urlToIds.get(url) ?? []) {
            if (!used.has(id)) { ids.push(id); used.add(id) }
          }
        }
        return {
          id: `grp-${g.source}-${Date.now()}-${i}`,
          title: g.title,
          color: g.color,
          tabIds: ids,
          tabUrls: g.urls,
          collapsed: false,
          source: (g.source === 'rule' ? 'manual' : g.source === 'local' ? 'domain' : 'ai') as VirtualGroup['source'],
          createdAt: Date.now(),
        }
      })
      .filter(g => g.tabIds.length > 0)

    await storage.groups.set(windowId, groups)
    await syncToBrowser(windowId, groups)

    return { groups, warning: plan.error ? `AI 不可用，已用本地聚类兜底：${plan.error}` : undefined }
  } catch (err) {
    return { groups: [], error: `分组失败: ${String(err)}` }
  }
}

/**
 * 新建一个分组并落盘，返回新的完整分组列表。
 * 被划走的标签要从原来的分组里摘掉，避免一个标签同时属于两个组。
 */
export async function createGroup(
  windowId: number,
  groups: VirtualGroup[],
  tabs: AppTab[],
  group: { title: string; color: GroupColor; tabIds: number[] },
): Promise<VirtualGroup[]> {
  const newGroup: VirtualGroup = {
    id: `grp-assist-${Date.now()}`,
    title: group.title,
    color: group.color,
    tabIds: group.tabIds,
    tabUrls: group.tabIds.map(id => tabs.find(t => t.id === id)?.url).filter((u): u is string => !!u),
    collapsed: false,
    source: 'manual',
    createdAt: Date.now(),
  }
  const taken = new Set(group.tabIds)
  const next = [
    ...groups
      .map(g => ({ ...g, tabIds: g.tabIds.filter(id => !taken.has(id)) }))
      .filter(g => g.tabIds.length > 0),
    newGroup,
  ]

  await storage.groups.set(windowId, next)
  await syncToBrowser(windowId, next)
  return next
}

function buildCleanupCandidates(tabs: AppTab[], idleThresholdMinutes: number): CleanupCandidateInput[] {
  const byUrl = new Map<string, AppTab[]>()
  for (const tab of tabs) {
    if (!tab.url || tab.pinned || tab.active || tab.audible) continue
    const list = byUrl.get(tab.url) ?? []
    list.push(tab)
    byUrl.set(tab.url, list)
  }

  const duplicateIds = new Set<number>()
  for (const list of byUrl.values()) {
    if (list.length > 1) {
      list.slice(1).forEach(tab => duplicateIds.add(tab.id))
    }
  }

  const now = Date.now()
  return tabs.flatMap(tab => {
    if (tab.pinned || tab.active || tab.audible) return []
    const idleMinutes = Math.floor((now - tab.lastAccessed) / 60000)
    const reasons: string[] = []
    if (duplicateIds.has(tab.id)) reasons.push('重复 URL')
    if (isNewTabUrl(tab.url)) reasons.push('新标签页')
    if (tab.discarded) reasons.push('已休眠')
    if (idleMinutes >= idleThresholdMinutes) reasons.push(`超过 ${idleThresholdMinutes} 分钟未访问`)
    if (reasons.length === 0) return []
    return [{ id: tab.id, title: tab.title || tab.url || '新标签', url: tab.url, reasons, idleMinutes }]
  })
}

// 建议关闭的全给，不确定的只留 5 条——不确定的越多，用户越懒得看
function compactCleanupItems(items: CleanupItem[]) {
  const closeItems = items.filter(item => item.decision === 'close')
  const unsureItems = items.filter(item => item.decision === 'unsure').slice(0, 5)
  return closeItems.length > 0 ? [...closeItems, ...unsureItems] : unsureItems
}

/** 挑出清理候选并交给 AI 判断。AI 不可用时候选仍然返回，标成「不确定」让用户自己看 */
export async function buildCleanupItems(tabs: AppTab[]): Promise<{ items: CleanupItem[]; error?: string }> {
  try {
    const config = await storage.config.get()
    const candidates = buildCleanupCandidates(tabs, config.suspend.idleMinutes)
    if (candidates.length === 0) return { items: [] }

    const { data, error } = await classifyTabsForCleanup(candidates, config)
    if (!data) {
      return {
        items: candidates.map(candidate => ({
          ...candidate,
          decision: 'unsure' as const,
          aiReason: error || 'AI 暂不可用，请手动判断',
          selected: false,
        })),
        error: error || 'AI 清理判断失败',
      }
    }

    const decisionById = new Map(data.map(item => [item.tabId, item]))
    const items = candidates.map(candidate => {
      const decision = decisionById.get(candidate.id)
      return {
        ...candidate,
        decision: decision?.decision ?? 'keep',
        aiReason: decision?.reason ?? 'AI 未建议关闭，默认保留',
        selected: decision?.decision === 'close',
      }
    }).sort((a, b) => {
      if (a.decision === 'close' && b.decision !== 'close') return -1
      if (a.decision !== 'close' && b.decision === 'close') return 1
      if (a.decision === 'unsure' && b.decision === 'keep') return -1
      if (a.decision === 'keep' && b.decision === 'unsure') return 1
      return 0
    })

    return { items: compactCleanupItems(items) }
  } catch (err) {
    return { items: [], error: String(err) }
  }
}
