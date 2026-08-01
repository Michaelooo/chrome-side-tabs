import { queryTabsInWindow } from '../lib/tab-manager'
import { stash } from '../lib/stash'
import { storage } from '../lib/storage'
import { logger } from '../lib/logger'

const ALARM_NAME = 'stash-check'

export function initStashManager() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 })
  chrome.alarms.onAlarm.addListener(handleAlarm)
  logger.info('Stash manager initialized')
}

async function handleAlarm(alarm: chrome.alarms.Alarm) {
  if (alarm.name !== ALARM_NAME) return

  const config = await storage.config.get()
  if (!config.stash.autoEnabled) return

  const threshold = config.stash.autoDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })

  for (const win of windows) {
    if (!win.id) continue
    const tabs = await queryTabsInWindow(win.id)

    // 休眠只省内存，归档才省注意力。够久没碰过的直接收进归档。
    const stale = tabs.filter(t =>
      !t.active && !t.pinned && !t.audible &&
      t.url && !t.url.startsWith('chrome://') &&
      now - t.lastAccessed > threshold,
    )
    if (stale.length === 0) continue

    // 不能把一个窗口清空，否则窗口会被一起关掉
    const keepCount = tabs.length - stale.length
    const targets = keepCount > 0 ? stale : stale.slice(0, -1)
    if (targets.length === 0) continue

    try {
      await stash.add(targets.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })), true)
      await chrome.tabs.remove(targets.map(t => t.id))
      logger.info(`Auto-stashed ${targets.length} tabs in window ${win.id}`)
    } catch (err) {
      logger.warn('Auto-stash failed', err)
    }
  }
}
