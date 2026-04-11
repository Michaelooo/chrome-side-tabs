import { initTabWatcher, refreshCurrentWindow, refreshWindow } from './tab-watcher'
import { triggerGrouping } from './ai-scheduler'
import { initSuspendManager, updateSuspendAlarm } from './suspend-manager'
import { initCommandHandler } from './command-handler'
import { activateTab, closeTab, pinTab, discardTab, queryTabsInWindow } from '../lib/tab-manager'
import { storage } from '../lib/storage'
import { onMessage } from '../lib/messaging'
import { findDuplicates } from '../lib/dedupe'
import { saveSession, restoreSession, deleteSession } from '../lib/session-manager'
import { logger } from '../lib/logger'
import type { MessageRequest, MessageResponse } from '../types/messages'

// Initialize all modules
chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed:', details.reason)

  // Set side panel to open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  // Open onboarding on first install
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
  }

  // Refresh all windows
  refreshCurrentWindow()
})

chrome.runtime.onStartup.addListener(() => {
  refreshCurrentWindow()
})

initTabWatcher()
initSuspendManager()
initCommandHandler()

// Handle messages from sidepanel
onMessage(async (msg: MessageRequest): Promise<MessageResponse> => {
  try {
    switch (msg.type) {
      case 'activate':
        await activateTab(msg.tabId)
        return { success: true }

      case 'close':
        await closeTab(msg.tabId)
        return { success: true }

      case 'closeOthers': {
        const tab = await chrome.tabs.get(msg.tabId)
        const allTabs = await queryTabsInWindow(tab.windowId)
        const toClose = allTabs.filter(t => t.id !== msg.tabId && !t.pinned).map(t => t.id)
        await chrome.tabs.remove(toClose)
        return { success: true }
      }

      case 'pin': {
        const tab = await chrome.tabs.get(msg.tabId)
        await pinTab(msg.tabId, !tab.pinned)
        return { success: true }
      }

      case 'discard':
        await discardTab(msg.tabId)
        return { success: true }

      case 'regroup': {
        const groups = await triggerGrouping(msg.windowId, msg.force)
        return { success: true, data: { groups } }
      }

      case 'saveSession': {
        const tabs = await queryTabsInWindow(msg.windowId)
        const groups = await storage.groups.get(msg.windowId)
        const session = await saveSession(msg.name, tabs, groups)
        return { success: true, data: session }
      }

      case 'restoreSession':
        await restoreSession(msg.sessionId)
        return { success: true }

      case 'deleteSession':
        await deleteSession(msg.sessionId)
        return { success: true }

      case 'getSessions': {
        const sessions = await storage.sessions.list()
        return { success: true, data: sessions }
      }

      case 'getDuplicates': {
        const tabs = await queryTabsInWindow(msg.windowId)
        const dupes = findDuplicates(tabs)
        return { success: true, data: dupes }
      }

      case 'closeDuplicates': {
        // Keep the tab with keepTabId, close all others with matching URLs
        const tabsToClose: number[] = []
        for (const url of msg.urls) {
          const found = await chrome.tabs.query({ url })
          for (const t of found) {
            if (t.id && t.id !== msg.keepTabId) {
              tabsToClose.push(t.id)
            }
          }
        }
        if (tabsToClose.length > 0) {
          await chrome.tabs.remove(tabsToClose)
        }
        return { success: true, data: { closed: tabsToClose.length } }
      }

      case 'toggleCommandPalette':
        // Just forward, handled by sidepanel
        return { success: true }

      case 'toggleGroupCollapse': {
        const groups = await storage.groups.get(msg.groupId as unknown as number)
        // This is a simplified version - toggle collapse for a group
        const updated = groups.map(g =>
          g.id === msg.groupId ? { ...g, collapsed: !g.collapsed } : g
        )
        // We need windowId - get from any tab in the group
        const window = await chrome.windows.getCurrent()
        if (window.id) {
          await storage.groups.set(window.id, updated)
        }
        return { success: true }
      }

      case 'getTabs': {
        const tabs = await queryTabsInWindow(msg.windowId)
        const groups = await storage.groups.get(msg.windowId)
        return { success: true, data: { tabs, groups } }
      }

      case 'getGroups': {
        const groups = await storage.groups.get(msg.windowId)
        return { success: true, data: { groups } }
      }

      case 'moveTab':
      case 'createGroup':
      case 'renameGroup':
      case 'deleteGroup':
        // TODO: Implement these in future phases
        return { success: true }

      default:
        return { success: false, error: `Unknown message type: ${(msg as { type: string }).type}` }
    }
  } catch (err) {
    logger.error('Message handler error:', err)
    return { success: false, error: String(err) }
  }
})
