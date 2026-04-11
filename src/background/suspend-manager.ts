import { queryTabsInWindow } from '../lib/tab-manager'
import { storage } from '../lib/storage'
import { logger } from '../lib/logger'

const ALARM_NAME = 'suspend-check'

export function initSuspendManager() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 })
  chrome.alarms.onAlarm.addListener(handleAlarm)
  logger.info('Suspend manager initialized')
}

async function handleAlarm(alarm: chrome.alarms.Alarm) {
  if (alarm.name !== ALARM_NAME) return

  const config = await storage.config.get()
  if (!config.suspend.enabled) return

  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  const threshold = config.suspend.idleMinutes * 60 * 1000
  const now = Date.now()
  const whitelist = new Set(config.suspend.whitelist)

  for (const win of windows) {
    if (!win.id) continue
    const tabs = await queryTabsInWindow(win.id)

    for (const tab of tabs) {
      if (tab.discarded || tab.active || tab.pinned || tab.audible) continue

      // Check whitelist
      try {
        const domain = new URL(tab.url).hostname
        if (whitelist.has(domain)) continue
      } catch { continue }

      const idle = now - tab.lastAccessed
      if (idle > threshold) {
        try {
          await chrome.tabs.discard(tab.id)
          logger.info(`Suspended tab ${tab.id}: ${tab.title}`)
        } catch (err) {
          logger.warn('Failed to discard tab', tab.id, err)
        }
      }
    }
  }
}

export async function updateSuspendAlarm(enabled: boolean) {
  if (enabled) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 })
  } else {
    chrome.alarms.clear(ALARM_NAME)
  }
}
