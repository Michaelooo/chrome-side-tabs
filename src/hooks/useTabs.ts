import { useEffect, useCallback } from 'react'
import { useTabsStore } from '../stores/tabsStore'
import { useUIStore } from '../stores/uiStore'
import { sendMessage } from '../lib/messaging'
import type { AppTab, VirtualGroup } from '../types/entities'

interface Snapshot {
  tabs: AppTab[]
  groups: VirtualGroup[]
}

export function useTabs() {
  const { tabs, groups, setTabs, setGroups, setLoading } = useTabsStore()
  const { currentWindowId, setCurrentWindowId } = useUIStore()

  // Load initial data
  useEffect(() => {
    async function load() {
      try {
        const window = await chrome.windows.getCurrent()
        setCurrentWindowId(window.id ?? chrome.windows.WINDOW_ID_CURRENT)

        const response = await sendMessage({ type: 'getTabs', windowId: window.id ?? chrome.windows.WINDOW_ID_CURRENT })
        if (response.success && response.data) {
          const snapshot = response.data as Snapshot
          setTabs(snapshot.tabs)
          setGroups(snapshot.groups)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [setTabs, setGroups, setLoading, setCurrentWindowId])

  // Listen for changes via storage
  useEffect(() => {
    function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }) {
      if (changes['tabs_snapshot']) {
        const map = changes['tabs_snapshot'].newValue as Record<number, Snapshot> | undefined
        if (map && currentWindowId && map[currentWindowId]) {
          setTabs(map[currentWindowId].tabs)
          setGroups(map[currentWindowId].groups ?? [])
        }
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [currentWindowId, setTabs, setGroups])

  const activateTab = useCallback(async (tabId: number) => {
    await sendMessage({ type: 'activate', tabId })
  }, [])

  const closeTab = useCallback(async (tabId: number) => {
    await sendMessage({ type: 'close', tabId })
  }, [])

  const closeOthers = useCallback(async (tabId: number) => {
    await sendMessage({ type: 'closeOthers', tabId })
  }, [])

  const pinTab = useCallback(async (tabId: number) => {
    await sendMessage({ type: 'pin', tabId })
  }, [])

  const discardTab = useCallback(async (tabId: number) => {
    await sendMessage({ type: 'discard', tabId })
  }, [])

  return { tabs, groups, activateTab, closeTab, closeOthers, pinTab, discardTab }
}
