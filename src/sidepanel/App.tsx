import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import { groupTabsWithAI, groupTabsByDomain, classifyTabsForCleanup } from '../lib/ai-client'
import type { CleanupCandidateInput, CleanupDecision } from '../lib/ai-client'
import { storage } from '../lib/storage'
import { applyGroupsToBrowser } from '../lib/tab-manager'

const GROUP_COLORS: Record<GroupColor, string> = {
  blue: '#4A90D9',
  red: '#D94A4A',
  yellow: '#D9C74A',
  green: '#4AD97A',
  pink: '#D94A90',
  purple: '#9B4AD9',
  cyan: '#4AD9D9',
  orange: '#D98A4A',
}

// 关闭标签的迸发彩蛋粒子：放射状方向与颜色
const BURST_PARTICLES = [
  { x: '16px', y: '0px', color: '#f59e0b', size: 5 },
  { x: '11px', y: '-11px', color: '#ef4444', size: 4 },
  { x: '0px', y: '-17px', color: '#ec4899', size: 5 },
  { x: '-11px', y: '-11px', color: '#a855f7', size: 4 },
  { x: '-16px', y: '0px', color: '#6366f1', size: 5 },
  { x: '-11px', y: '11px', color: '#22c55e', size: 4 },
  { x: '0px', y: '17px', color: '#06b6d4', size: 5 },
  { x: '11px', y: '11px', color: '#eab308', size: 4 },
  { x: '7px', y: '-5px', color: '#f97316', size: 3 },
  { x: '-7px', y: '5px', color: '#14b8a6', size: 3 },
]
const BURST_MS = 520

interface CleanupItem extends CleanupCandidateInput {
  decision: CleanupDecision['decision']
  aiReason: string
  selected: boolean
}

function isNewTabUrl(url: string) {
  return url === 'chrome://newtab/' || url === 'chrome://newtab' || url === 'about:blank'
}

function getHostname(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
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

function getDecisionLabel(decision: CleanupDecision['decision']) {
  if (decision === 'close') return '建议关闭'
  if (decision === 'keep') return '建议保留'
  return '不确定'
}

// 直接在 App 里查 tabs，不走 service worker 中转
// 因为 sidepanel 是 extension page，可以直接调 chrome.tabs
export default function App() {
  const [tabs, setTabs] = useState<AppTab[]>([])
  const [loading, setLoading] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<VirtualGroup[]>([])
  const [grouping, setGrouping] = useState(false)
  const [mouseY, setMouseY] = useState<number | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupItems, setCleanupItems] = useState<CleanupItem[]>([])
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const themeLoaded = useRef(false)

  useEffect(() => {
    chrome.storage.local.get('theme').then(({ theme: saved }) => {
      if (saved === 'light' || saved === 'dark') setTheme(saved)
      themeLoaded.current = true
    })
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    if (themeLoaded.current) {
      chrome.storage.local.set({ theme })
    }
  }, [theme])

  const refreshTabs = useCallback(async () => {
    try {
      const currentWin = await chrome.windows.getCurrent()
      const chromeTabs = await chrome.tabs.query({ windowId: currentWin.id })
      const appTabs: AppTab[] = chromeTabs
        .filter(t => t.id != null)
        .map(t => ({
          id: t.id!,
          windowId: t.windowId,
          index: t.index,
          title: t.title ?? '',
          url: t.url ?? '',
          favIconUrl: t.favIconUrl,
          active: t.active,
          pinned: t.pinned,
          audible: t.audible,
          discarded: t.discarded ?? false,
          lastAccessed: t.lastAccessed ?? Date.now(),
        }))
      setTabs(appTabs)
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    refreshTabs()
    async function loadGroups() {
      const win = await chrome.windows.getCurrent()
      const saved = await storage.groups.get(win.id!)
      if (saved.length === 0) return
      // 重连分组成员：先按 id 保留存活标签，再按 URL 认领重启后换了 id 的标签
      const liveTabs = await chrome.tabs.query({ windowId: win.id })
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
      if (cleaned.length > 0) {
        setGroups(cleaned)
        await storage.groups.set(win.id!, cleaned)
      }
    }
    loadGroups()
  }, [refreshTabs])

  // AI grouping
  const groupTabs = useCallback(async () => {
    if (grouping) return
    if (tabs.length < 2) return

    setGrouping(true)
    setError(null)
    try {
      const config = await storage.config.get()
      if (!config.ai.apiKey || !config.ai.baseURL) {
        chrome.runtime.openOptionsPage()
        setGrouping(false)
        return
      }

      const tabInputs = tabs.map((t, i) => ({ index: i, title: t.title, url: t.url }))

      // Try AI grouping
      const { data: aiResult, error: aiError } = await groupTabsWithAI(tabInputs, config, true)

      const win = await chrome.windows.getCurrent()

      if (!aiResult) {
        const errorMsg = aiError || '未知错误'
        setError(`AI 分组失败: ${errorMsg}`)
        // Fallback: group by domain
        const domainResult = groupTabsByDomain(tabInputs)
        const newGroups: VirtualGroup[] = domainResult.groups
          .filter(g => g.indices.length >= 1)
          .map((g, i) => ({
            id: `grp-domain-${Date.now()}-${i}`,
            title: g.title,
            color: (g.color in GROUP_COLORS ? g.color : 'blue') as GroupColor,
            tabIds: g.indices.map(idx => tabs[idx]?.id).filter((id): id is number => id != null),
            tabUrls: g.indices.map(idx => tabs[idx]?.url).filter((u): u is string => !!u),
            collapsed: false,
            source: 'domain' as const,
            createdAt: Date.now(),
          }))
        setGroups(newGroups)
        await storage.groups.set(win.id!, newGroups)
        try {
          await applyGroupsToBrowser(win.id!, newGroups)
        } catch (syncErr) {
          console.error('Failed to sync groups to browser:', syncErr)
        }
        return
      }

      const newGroups: VirtualGroup[] = aiResult.groups
        .filter(g => g.indices.length >= 1)
        .map((g, i) => ({
          id: `grp-ai-${Date.now()}-${i}`,
          title: g.title,
          color: (g.color in GROUP_COLORS ? g.color : 'blue') as GroupColor,
          tabIds: g.indices.map(idx => tabs[idx]?.id).filter((id): id is number => id != null),
          tabUrls: g.indices.map(idx => tabs[idx]?.url).filter((u): u is string => !!u),
          collapsed: false,
          source: 'ai' as const,
          createdAt: Date.now(),
        }))

      setGroups(newGroups)
      await storage.groups.set(win.id!, newGroups)
      try {
        await applyGroupsToBrowser(win.id!, newGroups)
      } catch (syncErr) {
        console.error('Failed to sync groups to browser:', syncErr)
      }
    } catch (err) {
      setError(`分组失败: ${String(err)}`)
    } finally {
      setGrouping(false)
    }
  }, [tabs, grouping])

  // Listen for tab events to refresh
  useEffect(() => {
    const events = [
      chrome.tabs.onCreated,
      chrome.tabs.onUpdated,
      chrome.tabs.onRemoved,
      chrome.tabs.onActivated,
      chrome.tabs.onMoved,
      chrome.tabs.onDetached,
      chrome.tabs.onAttached,
      chrome.tabs.onReplaced,
    ]
    // debounce multiple rapid events
    let timer: ReturnType<typeof setTimeout>
    const handler = () => {
      clearTimeout(timer)
      timer = setTimeout(refreshTabs, 100)
    }
    events.forEach(e => e.addListener(handler))
    return () => {
      events.forEach(e => e.removeListener(handler))
      clearTimeout(timer)
    }
  }, [refreshTabs])

  // Keyboard shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(prev => !prev)
        setSearchQuery('')
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function activateTab(tabId: number) {
    await chrome.tabs.update(tabId, { active: true })
  }

  async function closeTab(tabId: number) {
    await chrome.tabs.remove(tabId)
  }

  async function closeOtherTabs(keepId: number) {
    const toClose = tabs.filter(t => t.id !== keepId && !t.pinned).map(t => t.id)
    if (toClose.length > 0) await chrome.tabs.remove(toClose)
  }

  async function pinTab(tabId: number) {
    const tab = tabs.find(t => t.id === tabId)
    if (tab) await chrome.tabs.update(tabId, { pinned: !tab.pinned })
  }

  async function openCleanup() {
    setCleanupOpen(true)
    setCleanupLoading(true)
    setCleanupError(null)
    setCleanupItems([])
    try {
      const config = await storage.config.get()
      const candidates = buildCleanupCandidates(tabs, config.suspend.idleMinutes)
      if (candidates.length === 0) {
        setCleanupItems([])
        return
      }

      const { data, error } = await classifyTabsForCleanup(candidates, config)
      if (!data) {
        setCleanupError(error || 'AI 清理判断失败')
        setCleanupItems(candidates.map(candidate => ({
          ...candidate,
          decision: 'unsure',
          aiReason: error || 'AI 暂不可用，请手动判断',
          selected: false,
        })))
        return
      }

      const decisionById = new Map(data.map(item => [item.tabId, item]))
      const nextItems = candidates.map(candidate => {
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
      setCleanupItems(nextItems)
    } catch (err) {
      setCleanupError(String(err))
    } finally {
      setCleanupLoading(false)
    }
  }

  async function closeSelectedCleanupTabs() {
    const ids = cleanupItems.filter(item => item.selected).map(item => item.id)
    if (ids.length > 0) await chrome.tabs.remove(ids)
    setCleanupOpen(false)
    setCleanupItems([])
  }

  // Filtered tabs for search
  const filteredTabs = searchQuery
    ? tabs.filter(t =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.url.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : tabs

  return (
    <div className="flex flex-col h-screen select-none" style={{ background: 'var(--t-bg)', color: 'var(--t-text)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-11 shrink-0" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>标签</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full text-[10px] font-medium" style={{ background: 'var(--t-bg-active)', color: 'var(--t-text-muted)' }}>{tabs.length}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={groupTabs}
            disabled={grouping}
            className="p-1.5 rounded transition-colors"
            style={{ color: grouping ? '#6366f1' : 'var(--t-text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
            title="AI 整理"
          >
            {grouping ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                <path d="M12 2a10 10 0 019.8 8" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 2l.5 4 4 .5-4 .5-.5 4-.5-4-4-.5 4-.5z" /><path d="M18 8l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5z" /><path d="M13 16l.5 3 3 .5-3 .5-.5 3-.5-3-3-.5 3-.5z" />
              </svg>
            )}
          </button>
          <button
            onClick={openCleanup}
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--t-text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
            title="智能清理"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" />
            </svg>
          </button>
          <button
            onClick={() => { setSearchOpen(true); setSearchQuery('') }}
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--t-text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
            title="搜索 (⌘K)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
          </button>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--t-text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
            title={theme === 'dark' ? '切换浅色' : '切换深色'}
          >
            {theme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              </svg>
            )}
          </button>
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--t-text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
            title="设置"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tab List */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden py-1"
        onMouseMove={e => setMouseY(e.clientY)}
        onMouseLeave={() => setMouseY(null)}
      >
        {loading && (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: 'var(--t-text-muted)' }}>加载中...</div>
        )}

        {!loading && error && (
          <div className="mx-2 mt-2 p-3 rounded bg-red-900/30 text-red-300 text-xs">{error}</div>
        )}

        {!loading && !error && groups.length === 0 && filteredTabs.map(tab => (
          <TabRow
            key={tab.id}
            tab={tab}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onPin={() => pinTab(tab.id)}
            onCloseOthers={() => closeOtherTabs(tab.id)}
            mouseY={mouseY}
          />
        ))}

        {!loading && !error && groups.length > 0 && (
          <GroupedTabList
            groups={groups}
            setGroups={setGroups}
            tabs={filteredTabs}
            onActivate={activateTab}
            onClose={closeTab}
            onPin={pinTab}
            onCloseOthers={closeOtherTabs}
            mouseY={mouseY}
          />
        )}

        {!loading && !error && tabs.length === 0 && (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: 'var(--t-text-muted)' }}>没有打开的标签</div>
        )}
      </div>

      {/* New Tab button */}
      <div className="shrink-0 px-2 py-2" style={{ borderTop: '1px solid var(--t-border)' }}>
        <button
          onClick={() => chrome.tabs.create({ url: 'chrome://newtab' })}
          className="flex items-center justify-center gap-2 w-full py-1.5 rounded text-xs transition-colors"
          style={{ color: 'var(--t-text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建标签页
        </button>
      </div>

      {/* AI Grouping loading overlay */}
      {grouping && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 backdrop-blur-sm" style={{ background: 'var(--t-bg)' + 'cc' }}>
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2" style={{ borderColor: 'var(--t-border)' }} />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#6366f1] animate-spin" />
          </div>
          <span className="text-xs" style={{ color: 'var(--t-text-muted)' }}>正在拼命整理中...</span>
        </div>
      )}

      {/* Cleanup overlay */}
      {cleanupOpen && (
        <CleanupOverlay
          items={cleanupItems}
          loading={cleanupLoading}
          error={cleanupError}
          onToggle={tabId => setCleanupItems(prev => prev.map(item => item.id === tabId ? { ...item, selected: !item.selected } : item))}
          onClose={() => setCleanupOpen(false)}
          onConfirm={closeSelectedCleanupTabs}
        />
      )}

      {/* Search overlay */}
      {searchOpen && (
        <SearchOverlay
          tabs={tabs}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onSelect={tabId => { activateTab(tabId); setSearchOpen(false) }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  )
}

// --- Edge-like Tab Row ---
function TabRow({ tab, onActivate, onClose, onPin, onCloseOthers, groupAccent, mouseY }: {
  tab: AppTab
  onActivate: () => void
  onClose: () => void
  onPin: () => void
  onCloseOthers: () => void
  groupAccent?: string
  mouseY?: number | null
}) {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  // 先放迸发彩蛋动画，再真正关闭
  const handleClose = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, BURST_MS)
  }

  const scale = useMemo(() => {
    if (mouseY == null || !rowRef.current) return 1
    const rect = rowRef.current.getBoundingClientRect()
    const centerY = rect.top + rect.height / 2
    const distance = Math.abs(mouseY - centerY)
    const radius = 80
    const maxScale = 0.25
    return distance < radius ? 1 + maxScale * (1 - distance / radius) : 1
  }, [mouseY])

  const bgColor = tab.active
    ? 'var(--t-bg-active)'
    : hovered ? 'var(--t-bg-hover)' : 'transparent'

  return (
    <div
      ref={rowRef}
      className={`group relative flex items-center gap-2 px-3 rounded cursor-pointer ${tab.discarded && !closing ? 'opacity-40' : ''}`}
      style={{
        backgroundColor: bgColor,
        minHeight: '32px',
        paddingTop: '5px',
        paddingBottom: '5px',
        opacity: closing ? 0 : undefined,
        transform: closing ? 'translateX(10px)' : undefined,
        transition: closing ? 'opacity 300ms ease, transform 300ms ease' : undefined,
      }}
      onClick={onActivate}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenuOpen(false) }}
    >
      {/* Left accent bar for active tab */}
      {tab.active && (
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r"
          style={{ backgroundColor: groupAccent ?? '#6366f1' }}
        />
      )}

      {/* Favicon */}
      <div className="relative w-4 h-4 shrink-0 flex items-center justify-center">
        {closing ? (
          BURST_PARTICLES.map((p, i) => (
            <span
              key={i}
              className="absolute rounded-full"
              style={{
                width: p.size,
                height: p.size,
                background: p.color,
                boxShadow: `0 0 4px ${p.color}`,
                ['--bx' as string]: p.x,
                ['--by' as string]: p.y,
                animation: `tab-burst ${BURST_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards`,
              } as React.CSSProperties}
            />
          ))
        ) : tab.favIconUrl ? (
          <img
            src={tab.favIconUrl}
            alt=""
            className="w-4 h-4 rounded-sm"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-faint)" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
          </svg>
        )}
      </div>

      {/* Title */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div
          style={{ transform: `scale(${scale})`, transformOrigin: 'left center', transition: 'transform 0.08s ease', color: tab.active ? 'var(--t-text)' : 'var(--t-text-secondary)' }}
          className={`text-[12px] leading-tight truncate ${tab.pinned ? 'font-medium' : ''}`}
        >
          {tab.title || tab.url || '新标签'}
        </div>
        {tab.audible && (
          <svg className="absolute right-8 top-1/2 -translate-y-1/2" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
            <path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14" /><path d="M15.54 8.46a5 5 0 010 7.07" />
          </svg>
        )}
      </div>

      <button
        onClick={e => { e.stopPropagation(); handleClose() }}
        className="w-7 h-6 flex items-center justify-center rounded-full shrink-0 cursor-pointer transition-colors"
        style={{ color: hovered ? '#ef4444' : 'var(--t-text-faint)', background: hovered ? 'rgba(239,68,68,0.12)' : 'transparent' }}
        title="关闭标签"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Context menu trigger */}
      <button
        onClick={e => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
        className="w-4 h-4 p-0.5 rounded shrink-0 transition-opacity"
        style={{ color: 'var(--t-text-faint)', opacity: hovered || menuOpen ? 1 : 0, pointerEvents: hovered || menuOpen ? 'auto' : 'none' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-active)')}
        onMouseLeave={e => (e.currentTarget.style.background = '')}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {/* Context menu */}
      {menuOpen && (
        <div className="absolute right-1 top-full z-50 mt-1 py-1 rounded shadow-xl min-w-[120px]" style={{ background: 'var(--t-bg-active)', border: '1px solid var(--t-border)' }}>
          <button
            onClick={e => { e.stopPropagation(); onPin(); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px]"
            style={{ color: 'var(--t-text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            {tab.pinned ? '取消固定' : '固定标签'}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onCloseOthers(); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px]"
            style={{ color: 'var(--t-text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            关闭其他标签
          </button>
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(false); handleClose() }}
            className="w-full text-left px-3 py-1.5 text-[11px] text-red-400"
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            关闭标签
          </button>
        </div>
      )}
    </div>
  )
}

// Subtle group accent colors — muted, not flashy
const GROUP_ACCENT: Record<GroupColor, string> = {
  blue: '#5b8def',
  red: '#e06060',
  yellow: '#c9a84c',
  green: '#5cb87a',
  pink: '#d06baa',
  purple: '#9b7cd9',
  cyan: '#5bbcbf',
  orange: '#d08a4a',
}

// --- Grouped Tab List ---
function GroupedTabList({ groups, setGroups, tabs, onActivate, onClose, onPin, onCloseOthers, mouseY }: {
  groups: VirtualGroup[]
  setGroups: React.Dispatch<React.SetStateAction<VirtualGroup[]>>
  tabs: AppTab[]
  onActivate: (id: number) => void
  onClose: (id: number) => void
  onPin: (id: number) => void
  onCloseOthers: (id: number) => void
  mouseY?: number | null
}) {
  // 解析每个分组的成员：先按 id，再按 URL 兜底。标签被 Chrome 闲置/冻结后
  // tab id 会变（URL 不变），按 URL 匹配可让分组成员在 id 变化后自愈。
  const claimed = new Set<number>()
  const groupMembers = new Map<string, AppTab[]>()
  for (const g of groups) {
    const idSet = new Set(g.tabIds)
    const urlSet = g.tabUrls?.length ? new Set(g.tabUrls) : null
    const members: AppTab[] = []
    for (const t of tabs) {
      if (claimed.has(t.id)) continue
      if (idSet.has(t.id) || (urlSet && t.url && urlSet.has(t.url))) {
        members.push(t)
        claimed.add(t.id)
      }
    }
    groupMembers.set(g.id, members)
  }
  const ungroupedTabs = tabs.filter(t => !claimed.has(t.id))

  function toggleGroup(groupId: string) {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
    ))
  }

  return (
    <>
      {/* Ungrouped tabs */}
      {ungroupedTabs.length > 0 && groups.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mx-3 mt-1 mb-2">
            <div className="h-px flex-1" style={{ background: 'var(--t-border)' }} />
            <span className="text-[10px]" style={{ color: 'var(--t-text-faint)' }}>未分组 {ungroupedTabs.length}</span>
            <div className="h-px flex-1" style={{ background: 'var(--t-border)' }} />
          </div>
          {ungroupedTabs.map(tab => (
            <TabRow
              key={tab.id}
              tab={tab}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onPin={() => onPin(tab.id)}
              onCloseOthers={() => onCloseOthers(tab.id)}
              mouseY={mouseY}
            />
          ))}
        </div>
      )}

      {groups.map(group => {
        const groupTabs = groupMembers.get(group.id) ?? []
        // 成员标签全部关闭后隐藏空分组，不再展示标题与计数 0
        if (groupTabs.length === 0) return null
        const accent = GROUP_ACCENT[group.color] ?? GROUP_ACCENT.blue

        return (
          <div key={group.id} className="mb-3">
            {/* Group header */}
            <button
              onClick={() => toggleGroup(group.id)}
              className="flex items-center gap-2 w-full px-3 py-2 text-left rounded transition-colors"
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              {/* Colored dot */}
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: accent }} />
              <span className="text-[13px] font-semibold truncate flex-1" style={{ color: 'var(--t-text)' }}>
                {group.title}
              </span>
              <span className="text-[11px] tabular-nums mr-1" style={{ color: 'var(--t-text-muted)' }}>{groupTabs.length}</span>
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-faint)" strokeWidth="2.5"
                className={`transition-transform shrink-0 ${group.collapsed ? '-rotate-90' : ''}`}
              >
                <path d="M18 15l-6-6-6 6" />
              </svg>
            </button>

            {/* Group tabs — indented with left color border */}
            {!group.collapsed && (
              <div className="ml-3 pl-2" style={{ borderLeft: `2px solid ${accent}33` }}>
                {groupTabs.map(tab => (
                  <TabRow
                    key={tab.id}
                    tab={tab}
                    onActivate={() => onActivate(tab.id)}
                    onClose={() => onClose(tab.id)}
                    onPin={() => onPin(tab.id)}
                    onCloseOthers={() => onCloseOthers(tab.id)}
                    groupAccent={accent}
                    mouseY={mouseY}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}


// --- Cleanup Overlay ---
function CleanupOverlay({ items, loading, error, onToggle, onClose, onConfirm }: {
  items: CleanupItem[]
  loading: boolean
  error: string | null
  onToggle: (tabId: number) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const selectedCount = items.filter(item => item.selected).length

  return (
    <div className="absolute inset-0 z-50 bg-black/50 flex items-start justify-center pt-6" onClick={onClose}>
      <div className="w-[calc(100%-12px)] max-h-[calc(100%-48px)] rounded-lg border shadow-2xl overflow-hidden flex flex-col" style={{ background: 'var(--t-bg-active)', borderColor: 'var(--t-border)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--t-border)' }}>
          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>智能清理</div>
            <div className="text-[10px]" style={{ color: 'var(--t-text-muted)' }}>确认后才会关闭标签</div>
          </div>
          <button className="p-1 rounded" style={{ color: 'var(--t-text-muted)' }} onClick={onClose}>×</button>
        </div>

        <div className="overflow-y-auto p-2 flex-1">
          {loading && <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>AI 正在判断候选标签...</div>}
          {!loading && error && <div className="mb-2 p-2 rounded text-xs bg-red-900/30 text-red-300">{error}</div>}
          {!loading && items.length === 0 && <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>没有发现需要清理的候选标签</div>}
          {!loading && items.map(item => (
            <label key={item.id} className="flex gap-2 p-2 rounded cursor-pointer" style={{ color: 'var(--t-text-secondary)' }}>
              <input type="checkbox" checked={item.selected} onChange={() => onToggle(item.id)} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: item.decision === 'close' ? 'rgba(239,68,68,0.16)' : 'var(--t-bg)', color: item.decision === 'close' ? '#ef4444' : 'var(--t-text-muted)' }}>{getDecisionLabel(item.decision)}</span>
                  <span className="text-[10px] truncate" style={{ color: 'var(--t-text-faint)' }}>{getHostname(item.url)}</span>
                </div>
                <div className="text-xs truncate" style={{ color: 'var(--t-text)' }}>{item.title}</div>
                <div className="text-[10px] truncate" style={{ color: 'var(--t-text-faint)' }}>{item.url}</div>
                <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--t-text-muted)' }}>
                  {item.aiReason}；候选原因：{item.reasons.join('、')}
                </div>
              </div>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--t-border)' }}>
          <span className="text-[10px]" style={{ color: 'var(--t-text-muted)' }}>已选 {selectedCount} 个</span>
          <div className="flex gap-2">
            <button className="px-3 py-1.5 rounded text-xs" style={{ color: 'var(--t-text-muted)' }} onClick={onClose}>取消</button>
            <button
              className="px-3 py-1.5 rounded text-xs disabled:opacity-40"
              style={{ background: '#ef4444', color: '#fff' }}
              disabled={selectedCount === 0}
              onClick={onConfirm}
            >
              关闭选中标签
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Search Overlay ---
function SearchOverlay({ tabs, query, onQueryChange, onSelect, onClose }: {
  tabs: AppTab[]
  query: string
  onQueryChange: (q: string) => void
  onSelect: (tabId: number) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = query
    ? tabs.filter(t =>
        t.title.toLowerCase().includes(query.toLowerCase()) ||
        t.url.toLowerCase().includes(query.toLowerCase())
      )
    : tabs

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      onSelect(results[selectedIndex].id)
    }
  }

  return (
    <div className="absolute inset-0 z-50 bg-black/50 flex items-start justify-center pt-6" onClick={onClose}>
      <div className="w-[calc(100%-12px)] rounded-lg border shadow-2xl overflow-hidden" style={{ background: 'var(--t-bg-active)', borderColor: 'var(--t-border)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--t-border)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { onQueryChange(e.target.value); setSelectedIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder="搜索标签..."
            className="flex-1 bg-transparent text-xs focus:outline-none"
            style={{ color: 'var(--t-text)' }}
          />
          <kbd className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--t-bg)', color: 'var(--t-text-muted)' }}>ESC</kbd>
        </div>
        <div className="max-h-60 overflow-y-auto">
          {results.map((tab, i) => (
            <button
              key={tab.id}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs transition-colors"
              style={{ background: i === selectedIndex ? 'var(--t-bg-hover)' : undefined, color: 'var(--t-text)' }}
              onClick={() => onSelect(tab.id)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              {tab.favIconUrl ? (
                <img src={tab.favIconUrl} alt="" className="w-3.5 h-3.5 shrink-0 rounded-sm" />
              ) : (
                <div className="w-3.5 h-3.5 shrink-0 rounded-sm" style={{ background: 'var(--t-border)' }} />
              )}
              <div className="flex-1 min-w-0 truncate">{tab.title || tab.url}</div>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px]" style={{ color: 'var(--t-text-muted)' }}>无匹配结果</div>
          )}
        </div>
      </div>
    </div>
  )
}
