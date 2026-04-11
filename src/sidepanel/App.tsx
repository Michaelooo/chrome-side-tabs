import { useState, useEffect, useCallback, useRef } from 'react'
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
  }, [refreshTabs])

  // AI grouping
  const groupTabs = useCallback(async () => {
    if (grouping) return
    if (tabs.length < 2) return

    // If already grouped, clear groups
    if (groups.length > 0) {
      setGroups([])
      return
    }

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
    } catch (err) {
      setError(`分组失败: ${String(err)}`)
    } finally {
      setGrouping(false)
    }
  }, [tabs, groups, grouping])

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
    <div className="flex flex-col h-screen bg-[#1c1c1c] text-[#e0e0e0] select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-2 h-10 shrink-0 border-b border-[#333]">
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.close()}
            className="p-1.5 rounded hover:bg-[#333] transition-colors"
            title="关闭侧边栏"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <span className="text-xs text-[#888]">{tabs.length} 个标签</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={groupTabs}
            disabled={grouping}
            className={`p-1.5 rounded transition-colors ${grouping ? 'animate-pulse text-[#6366f1]' : 'hover:bg-[#333]'} ${groups.length > 0 ? 'text-[#6366f1]' : ''}`}
            title={groups.length > 0 ? '清除分组' : 'AI 分组'}
          >
            {grouping ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                <path d="M12 2a10 10 0 019.8 8" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M15 4V2" /><path d="M15 16v-2" /><path d="M8 9h2" /><path d="M20 9h2" /><path d="M17.8 11.8L19 13" /><path d="M15 9h0" /><path d="M17.8 6.2L19 5" /><path d="M3 21l9-9" /><path d="M12.2 6.2L11 5" />
              </svg>
            )}
          </button>
          <button
            onClick={() => { setSearchOpen(true); setSearchQuery('') }}
            className="p-1.5 rounded hover:bg-[#333] transition-colors"
            title="搜索 (⌘K)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tab List */}
      <div className="flex-1 overflow-y-auto py-0.5">
        {loading && (
          <div className="flex items-center justify-center h-20 text-[#666] text-xs">加载中...</div>
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
          />
        )}

        {!loading && !error && tabs.length === 0 && (
          <div className="flex items-center justify-center h-20 text-[#666] text-xs">没有打开的标签</div>
        )}
      </div>

      {/* New Tab button */}
      <div className="shrink-0 border-t border-[#333] px-1 py-1">
        <button
          onClick={() => chrome.tabs.create({ url: 'chrome://newtab' })}
          className="flex items-center gap-2 w-full px-3 py-1.5 rounded text-xs text-[#999] hover:bg-[#333] transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新标签
        </button>
      </div>

      {/* AI Grouping loading overlay */}
      {grouping && (
        <div className="absolute inset-0 z-40 bg-[#1c1c1c]/80 flex flex-col items-center justify-center gap-3 backdrop-blur-sm">
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2 border-[#333]" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#6366f1] animate-spin" />
          </div>
          <span className="text-xs text-[#999]">正在拼命整理中...</span>
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
function TabRow({ tab, onActivate, onClose, onPin, onCloseOthers, groupAccent }: {
  tab: AppTab
  onActivate: () => void
  onClose: () => void
  onPin: () => void
  onCloseOthers: () => void
  groupAccent?: string
}) {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div
      className={`group relative flex items-center gap-2 mx-1 my-[1px] px-2 py-[6px] rounded cursor-pointer transition-all duration-100 ${
        tab.active
          ? 'bg-[#2d2d2d] text-white'
          : 'text-[#ccc] hover:bg-[#282828]'
      } ${tab.discarded ? 'opacity-40' : ''}`}
      onClick={onActivate}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenuOpen(false) }}
    >
      {/* Left accent bar for active tab */}
      {tab.active && (
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r"
          style={{ backgroundColor: groupAccent ?? '#6366f1' }}
        />
      )}

      {/* Favicon */}
      <div className="w-4 h-4 shrink-0 flex items-center justify-center">
        {tab.favIconUrl ? (
          <img
            src={tab.favIconUrl}
            alt=""
            className="w-4 h-4 rounded-sm"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
          </svg>
        )}
      </div>

      {/* Title */}
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] leading-tight truncate ${tab.pinned ? 'font-medium' : ''}`}>
          {tab.title || tab.url || '新标签'}
        </div>
        {tab.audible && (
          <svg className="absolute right-8 top-1/2 -translate-y-1/2" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
            <path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14" /><path d="M15.54 8.46a5 5 0 010 7.07" />
          </svg>
        )}
      </div>

      {/* Close button */}
      {(hovered || tab.active) && (
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          className="p-0.5 rounded shrink-0 opacity-0 group-hover:opacity-100 hover:bg-[#444] transition-opacity"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Context menu trigger */}
      {hovered && (
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
          className="p-0.5 rounded shrink-0 opacity-0 group-hover:opacity-100 hover:bg-[#444] transition-opacity"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
          </svg>
        </button>
      )}

      {/* Context menu */}
      {menuOpen && (
        <div className="absolute right-1 top-full z-50 mt-1 py-1 rounded bg-[#2d2d2d] border border-[#444] shadow-xl min-w-[120px]">
          <button
            onClick={e => { e.stopPropagation(); onPin(); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#3a3a3a]"
          >
            {tab.pinned ? '取消固定' : '固定标签'}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onCloseOthers(); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#3a3a3a]"
          >
            关闭其他标签
          </button>
          <button
            onClick={e => { e.stopPropagation(); onClose(); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px] text-red-400 hover:bg-[#3a3a3a]"
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
function GroupedTabList({ groups, setGroups, tabs, onActivate, onClose, onPin, onCloseOthers }: {
  groups: VirtualGroup[]
  setGroups: React.Dispatch<React.SetStateAction<VirtualGroup[]>>
  tabs: AppTab[]
  onActivate: (id: number) => void
  onClose: (id: number) => void
  onPin: (id: number) => void
  onCloseOthers: (id: number) => void
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
          <div key={group.id} className="mb-1">
            {/* Group header — bold, larger, colored accent */}
            <button
              onClick={() => toggleGroup(group.id)}
              className="flex items-center gap-2 w-full px-3 py-[6px] text-left hover:bg-[#282828] transition-colors"
            >
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2.5"
                className={`transition-transform shrink-0 ${group.collapsed ? '' : 'rotate-90'}`}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              <span className="text-[13px] font-semibold truncate flex-1" style={{ color: accent }}>
                {group.title}
              </span>
              <span className="text-[10px] text-[#555] tabular-nums">{groupTabs.length}</span>
            </button>

            {/* Group tabs — indented under group header */}
            {!group.collapsed && (
              <div className="pl-4">
                {groupTabs.map(tab => (
                  <TabRow
                    key={tab.id}
                    tab={tab}
                    onActivate={() => onActivate(tab.id)}
                    onClose={() => onClose(tab.id)}
                    onPin={() => onPin(tab.id)}
                    onCloseOthers={() => onCloseOthers(tab.id)}
                    groupAccent={accent}
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
          <div className="flex items-center gap-2 mx-2 mt-1 mb-0.5">
            <div className="h-px flex-1 bg-[#333]" />
            <span className="text-[10px] text-[#555]">其他 ({ungroupedTabs.length})</span>
            <div className="h-px flex-1 bg-[#333]" />
          </div>
          {ungroupedTabs.map(tab => (
            <TabRow
              key={tab.id}
              tab={tab}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onPin={() => onPin(tab.id)}
              onCloseOthers={() => onCloseOthers(tab.id)}
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
    <div className="absolute inset-0 z-50 bg-black/70 flex items-start justify-center pt-6" onClick={onClose}>
      <div className="w-[calc(100%-12px)] bg-[#2d2d2d] rounded-lg border border-[#444] shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#444]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { onQueryChange(e.target.value); setSelectedIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder="搜索标签..."
            className="flex-1 bg-transparent text-xs focus:outline-none placeholder:text-[#666]"
          />
          <kbd className="text-[9px] px-1 py-0.5 rounded bg-[#1c1c1c] text-[#666]">ESC</kbd>
        </div>
        <div className="max-h-60 overflow-y-auto">
          {results.map((tab, i) => (
            <button
              key={tab.id}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs transition-colors ${
                i === selectedIndex ? 'bg-[#3a3a3a]' : 'hover:bg-[#333]'
              }`}
              onClick={() => onSelect(tab.id)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              {tab.favIconUrl ? (
                <img src={tab.favIconUrl} alt="" className="w-3.5 h-3.5 shrink-0 rounded-sm" />
              ) : (
                <div className="w-3.5 h-3.5 shrink-0 rounded-sm bg-[#444]" />
              )}
              <div className="flex-1 min-w-0 truncate">{tab.title || tab.url}</div>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-[#666]">无匹配结果</div>
          )}
        </div>
      </div>
    </div>
  )
}
