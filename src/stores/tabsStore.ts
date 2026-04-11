import { create } from 'zustand'
import type { AppTab, VirtualGroup } from '../types/entities'

interface TabsState {
  tabs: AppTab[]
  groups: VirtualGroup[]
  loading: boolean
  setTabs: (tabs: AppTab[]) => void
  setGroups: (groups: VirtualGroup[]) => void
  setLoading: (loading: boolean) => void
  getUngroupedTabs: () => AppTab[]
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  groups: [],
  loading: true,
  setTabs: (tabs) => set({ tabs }),
  setGroups: (groups) => set({ groups }),
  setLoading: (loading) => set({ loading }),
  getUngroupedTabs: () => {
    const { tabs, groups } = get()
    const groupedIds = new Set(groups.flatMap(g => g.tabIds))
    return tabs.filter(t => !groupedIds.has(t.id))
  },
}))
