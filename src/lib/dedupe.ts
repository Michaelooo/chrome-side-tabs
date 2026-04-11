import type { AppTab } from '../types/entities'

export interface DuplicateGroup {
  url: string
  tabs: AppTab[]
}

export function findDuplicates(tabs: AppTab[]): DuplicateGroup[] {
  const urlMap = new Map<string, AppTab[]>()
  for (const tab of tabs) {
    if (!tab.url || tab.url === 'chrome://newtab/') continue
    const existing = urlMap.get(tab.url)
    if (existing) {
      existing.push(tab)
    } else {
      urlMap.set(tab.url, [tab])
    }
  }
  return Array.from(urlMap.entries())
    .filter(([, ts]) => ts.length > 1)
    .map(([url, ts]) => ({ url, tabs: ts }))
}
