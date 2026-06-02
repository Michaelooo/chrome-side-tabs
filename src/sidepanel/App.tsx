import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import { groupTabsWithAI, groupTabsByDomain } from '../lib/ai-client'
import { storage } from '../lib/storage'

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
      // 过滤掉已关闭的标签 id
      const liveTabs = await chrome.tabs.query({ windowId: win.id })
      const liveIds = new Set(liveTabs.map(t => t.id))
      const cleaned = saved
        .map(g => ({ ...g, tabIds: g.tabIds.filter(id => liveIds.has(id)) }))
        .filter(g => g.tabIds.length > 0)
      if (cleaned.length > 0) setGroups(cleaned)
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
            collapsed: false,
            source: 'domain' as const,
            createdAt: Date.now(),
          }))
        setGroups(newGroups)
        await storage.groups.set(win.id!, newGroups)
        return
      }

      const newGroups: VirtualGroup[] = aiResult.groups
        .filter(g => g.indices.length >= 1)
        .map((g, i) => ({
          id: `grp-ai-${Date.now()}-${i}`,
          title: g.title,
          color: (g.color in GROUP_COLORS ? g.color : 'blue') as GroupColor,
          tabIds: g.indices.map(idx => tabs[idx]?.id).filter((id): id is number => id != null),
          collapsed: false,
          source: 'ai' as const,
          createdAt: Date.now(),
        }))

      setGroups(newGroups)
      await storage.groups.set(win.id!, newGroups)
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
  const rowRef = useRef<HTMLDivElement>(null)

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
      className={`group relative flex items-center gap-2 px-3 rounded cursor-pointer ${tab.discarded ? 'opacity-40' : ''}`}
      style={{ backgroundColor: bgColor, minHeight: '32px', paddingTop: '5px', paddingBottom: '5px' }}
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

      {/* Favicon / Close button */}
      <div className="w-4 h-4 shrink-0 flex items-center justify-center">
        {hovered ? (
          <button
            onClick={e => { e.stopPropagation(); onClose() }}
            className="w-4 h-4 flex items-center justify-center rounded bg-red-500 hover:bg-red-600"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
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
      <div className="flex-1 min-w-0">
        <div
          style={{ transform: `scale(${scale})`, transformOrigin: 'left center', transition: 'transform 0.08s ease', display: 'inline-block', maxWidth: '100%', color: tab.active ? 'var(--t-text)' : 'var(--t-text-secondary)' }}
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

      {/* Context menu trigger */}
      {hovered && (
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
          className="p-0.5 rounded shrink-0"
          style={{ color: 'var(--t-text-faint)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-active)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
          </svg>
        </button>
      )}

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
            onClick={e => { e.stopPropagation(); onClose(); setMenuOpen(false) }}
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
  const groupedTabIds = new Set(groups.flatMap(g => g.tabIds))
  const ungroupedTabs = tabs.filter(t => !groupedTabIds.has(t.id))

  function toggleGroup(groupId: string) {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
    ))
  }

  return (
    <>
      {groups.map(group => {
        const groupTabs = group.tabIds
          .map(id => tabs.find(t => t.id === id))
          .filter((t): t is AppTab => t != null)
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

      {/* Ungrouped tabs */}
      {ungroupedTabs.length > 0 && groups.length > 0 && (
        <>
          <div className="flex items-center gap-2 mx-3 mt-1 mb-2">
            <div className="h-px flex-1" style={{ background: 'var(--t-border)' }} />
            <span className="text-[10px]" style={{ color: 'var(--t-text-faint)' }}>其他 {ungroupedTabs.length}</span>
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
        </>
      )}
    </>
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
