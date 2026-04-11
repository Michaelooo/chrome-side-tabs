import type { AppTab, Session, VirtualGroup } from '../types/entities'
import { storage } from './storage'
import { v4 as uuid } from 'uuid'

export async function saveSession(name: string, tabs: AppTab[], groups: VirtualGroup[]): Promise<Session> {
  const session: Session = {
    id: uuid(),
    name,
    createdAt: Date.now(),
    tabs: tabs.map(t => ({ title: t.title, url: t.url, pinned: t.pinned })),
    groups: groups.map(g => ({
      title: g.title,
      color: g.color,
      source: g.source,
      tabUrls: g.tabIds.map(id => tabs.find(t => t.id === id)?.url).filter(Boolean) as string[],
    })),
  }
  await storage.sessions.add(session)
  return session
}

export async function restoreSession(sessionId: string): Promise<void> {
  const sessions = await storage.sessions.list()
  const session = sessions.find(s => s.id === sessionId)
  if (!session) return

  const currentWindow = await chrome.windows.getCurrent()
  if (!currentWindow.id) return

  // Create all tabs
  for (const tab of session.tabs) {
    await chrome.tabs.create({
      url: tab.url,
      pinned: tab.pinned,
      windowId: currentWindow.id,
    })
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await storage.sessions.remove(sessionId)
}
