import { storage } from '../lib/storage'
import { groupTabsWithAI, groupTabsByDomain } from '../lib/ai-client'
import { queryTabsInWindow, applyGroupsToBrowser } from '../lib/tab-manager'
import { logger } from '../lib/logger'
import type { VirtualGroup, AppTab } from '../types/entities'
import { v4 as uuid } from 'uuid'

let isRunning = false
const lastRunAt = new Map<number, number>()

export async function triggerGrouping(windowId: number, force = false): Promise<VirtualGroup[]> {
  const config = await storage.config.get()

  if (!force) {
    const last = lastRunAt.get(windowId) ?? 0
    if (Date.now() - last < config.grouping.throttleMs) {
      logger.info('Throttled, skipping grouping for window', windowId)
      return []
    }
  }

  if (isRunning) {
    logger.info('AI grouping already running, skipping')
    return []
  }

  isRunning = true
  try {
    const tabs = await queryTabsInWindow(windowId)
    const aiTabs = tabs.map((t, i) => ({ index: i, title: t.title, url: t.url }))

    // Try AI first
    const { data: aiResult } = await groupTabsWithAI(aiTabs, config, force)

    // Fallback to domain grouping
    let result = aiResult
    if (!result) {
      logger.info('AI grouping failed, falling back to domain grouping')
      result = groupTabsByDomain(aiTabs)
    }

    if (!result) return []

    const groups = result.groups.map((g: { title: string; color: string; indices: number[] }) => ({
      id: uuid(),
      title: g.title,
      color: (['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(g.color)
        ? g.color
        : 'blue') as VirtualGroup['color'],
      tabIds: g.indices.map((i: number) => tabs[i]?.id).filter((id: number | undefined): id is number => id !== undefined),
      collapsed: false,
      source: 'ai' as const,
      createdAt: Date.now(),
    }))

    await storage.groups.set(windowId, groups)
    lastRunAt.set(windowId, Date.now())
    logger.info(`Grouped ${tabs.length} tabs into ${groups.length} groups`)

    // 同步到 Chrome 原生标签组，失败不影响主流程
    try {
      await applyGroupsToBrowser(windowId, groups)
    } catch (syncErr) {
      logger.error('Failed to sync groups to browser:', syncErr)
    }

    // Also update snapshot with new groups
    const snapshot = await storage.tabsSnapshot.get(windowId)
    if (snapshot) {
      const snapshotData = snapshot as { tabs: AppTab[]; groups?: VirtualGroup[] }
      await storage.tabsSnapshot.set(windowId, { tabs: snapshotData.tabs, groups })
    }

    return groups
  } catch (err) {
    logger.error('AI grouping error:', err)
    return []
  } finally {
    isRunning = false
  }
}
