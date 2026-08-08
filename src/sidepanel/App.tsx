import { useState, useEffect, useCallback, useRef } from 'react'
import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import { stash, stashAndClose } from '../lib/stash'
import Assistant from './Assistant'
import CleanupOverlay from '../panels/CleanupOverlay'
import StashDrawer from '../panels/StashDrawer'
import { runGrouping, createGroup, buildCleanupItems, loadGroups } from '../lib/tab-tools'
import type { CleanupItem } from '../lib/tab-tools'
import { provenance, buildTabTree, flattenTree, collectSubtreeIds } from '../lib/provenance'
import type { TabOrigin, TabNode } from '../lib/provenance'

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
const BURST_MS = 140

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
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list')
  const [origins, setOrigins] = useState<Record<number, TabOrigin>>({})
  const [collapsedNodes, setCollapsedNodes] = useState<Set<number>>(new Set())
  const [stashOpen, setStashOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  // 助手高亮出来的标签
  const [highlighted, setHighlighted] = useState<Set<number>>(new Set())
  const [stashCount, setStashCount] = useState(0)
  const [focusGroupId, setFocusGroupId] = useState<string | null>(null)
  const [cursor, setCursor] = useState(-1)
  const themeLoaded = useRef(false)
  // 键盘导航要读到最新的可见列表，但监听器只注册一次，用 ref 传递
  const navRef = useRef<{ tabs: AppTab[]; overlay: boolean; cursor: number }>({ tabs: [], overlay: false, cursor: -1 })

  const refreshStashCount = useCallback(async () => {
    setStashCount(await stash.count())
  }, [])

  useEffect(() => { refreshStashCount() }, [refreshStashCount])

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
          muted: t.mutedInfo?.muted ?? false,
          splitViewId: t.splitViewId,
          lastAccessed: t.lastAccessed ?? Date.now(),
        }))
      setTabs(appTabs)
      setOrigins(await provenance.getAll())
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
    chrome.windows.getCurrent().then(async win => {
      const saved = await loadGroups(win.id!)
      if (saved.length > 0) setGroups(saved)
    })
  }, [refreshTabs])

  // AI 分组：规则先行 → 复用缓存 → 只把没见过的标签送给 AI → 失败时本地聚类兜底
  const groupTabs = useCallback(async (forceRefresh = false) => {
    if (grouping) return
    if (tabs.length < 2) return

    setGrouping(true)
    setError(null)
    try {
      const win = await chrome.windows.getCurrent()
      const result = await runGrouping(tabs, win.id!, { forceRefresh })
      if (result.notConfigured) {
        chrome.runtime.openOptionsPage()
        return
      }
      // 硬失败时分组没落盘，界面上也保持原样
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.warning) setError(result.warning)
      setGroups(result.groups)
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

      // 侧栏常驻，列表内导航不该逼人用鼠标。
      // 输入框里打字时不接管按键。
      const target = e.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return

      const { tabs: list, overlay, cursor: at } = navRef.current
      if (overlay || list.length === 0) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => Math.min(c + 1, list.length - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => Math.max(c - 1, 0))
      } else if (e.key === 'Enter') {
        // 副作用不能写在 setState 的 updater 里，StrictMode 下会被调用两次
        if (list[at]) activateTab(list[at].id)
      } else if (e.key === 'x') {
        if (list[at]) {
          closeTab(list[at].id)
          setCursor(Math.max(0, Math.min(at, list.length - 2)))
        }
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

  async function toggleMute(tabId: number) {
    const tab = tabs.find(t => t.id === tabId)
    if (tab) await chrome.tabs.update(tabId, { muted: !tab.muted })
  }

  // 归档：关掉但不丢。这是"关了就找不回来"那份恐惧的解药。
  async function stashTabs(targets: AppTab[], groupTitle?: string) {
    if (targets.length === 0) return
    await stashAndClose(targets, groupTitle)
    await refreshStashCount()
  }

  // 同 URL 的重复标签，保留第一个，其余直接关掉
  async function mergeDuplicates(url: string, keepId: number) {
    const ids = tabs.filter(t => t.url === url && t.id !== keepId).map(t => t.id)
    if (ids.length > 0) await chrome.tabs.remove(ids)
  }

  // Focus 模式：只留选中的组，其余全部折叠并休眠
  async function toggleFocus(groupId: string) {
    if (focusGroupId === groupId) {
      setFocusGroupId(null)
      setGroups(prev => prev.map(g => ({ ...g, collapsed: false })))
      return
    }
    setFocusGroupId(groupId)
    setGroups(prev => prev.map(g => ({ ...g, collapsed: g.id !== groupId })))
    const keep = new Set(groups.find(g => g.id === groupId)?.tabIds ?? [])
    for (const tab of tabs) {
      if (keep.has(tab.id) || tab.active || tab.pinned || tab.audible || tab.discarded) continue
      try { await chrome.tabs.discard(tab.id) } catch { /* 可能已关闭 */ }
    }
  }

  async function openCleanup() {
    setCleanupOpen(true)
    setCleanupLoading(true)
    setCleanupError(null)
    setCleanupItems([])
    try {
      const { items, error } = await buildCleanupItems(tabs)
      setCleanupItems(items)
      if (error) setCleanupError(error)
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

  // 归档比关闭安全得多，AI 判断错了也不会真的丢东西
  async function stashSelectedCleanupTabs() {
    const ids = new Set(cleanupItems.filter(item => item.selected).map(item => item.id))
    const targets = tabs.filter(t => ids.has(t.id))
    await stashTabs(targets)
    setCleanupOpen(false)
    setCleanupItems([])
  }

  // 助手要建分组时回调到这里
  async function createGroupFromAssistant(title: string, color: GroupColor, tabIds: number[]) {
    const win = await chrome.windows.getCurrent()
    setGroups(await createGroup(win.id!, groups, tabs, { title, color, tabIds }))
  }

  // 助手指出的标签高亮几秒后淡出
  const highlightTabs = useCallback((tabIds: number[]) => {
    setHighlighted(new Set(tabIds))
    setTimeout(() => setHighlighted(new Set()), 6000)
  }, [])

  async function closeSubtree(node: TabNode) {
    const ids = collectSubtreeIds(node)
    if (ids.length > 0) await chrome.tabs.remove(ids)
  }

  function toggleNode(tabId: number) {
    setCollapsedNodes(prev => {
      const next = new Set(prev)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      return next
    })
  }

  // Filtered tabs for search
  const filteredTabs = searchQuery
    ? tabs.filter(t =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.url.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : tabs

  // 来源链路视图：按 openerTabId 串成树，摊平后渲染
  const treeNodes = viewMode === 'tree'
    ? flattenTree(buildTabTree(filteredTabs, origins), collapsedNodes)
    : []

  // 同 URL 的标签数，用来在行内标 ×N 角标
  const dupCount = new Map<string, number>()
  for (const t of tabs) {
    if (t.url) dupCount.set(t.url, (dupCount.get(t.url) ?? 0) + 1)
  }
  const dupFirstId = new Map<string, number>()
  for (const t of tabs) {
    if (t.url && !dupFirstId.has(t.url)) dupFirstId.set(t.url, t.id)
  }

  // 键盘导航要走和界面一致的顺序
  const visibleTabs: AppTab[] = viewMode === 'tree'
    ? treeNodes.map(n => n.tab)
    : groups.length > 0
      ? (() => {
          const { groupMembers, ungrouped } = resolveGroupMembers(groups, filteredTabs)
          const out = [...ungrouped]
          for (const g of groups) {
            if (g.collapsed) continue
            out.push(...(groupMembers.get(g.id) ?? []))
          }
          return out
        })()
      : filteredTabs

  const anyOverlayOpen = searchOpen || stashOpen || cleanupOpen || assistantOpen
  navRef.current = { tabs: visibleTabs, overlay: anyOverlayOpen, cursor }

  // 标签一多，鼠标跟随放大就会让整个列表每帧重渲染，得不偿失
  const magnifyEnabled = tabs.length <= 60

  return (
    <div className="flex flex-col h-screen select-none" style={{ background: 'var(--t-bg)', color: 'var(--t-text)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-11 shrink-0" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>标签</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full text-[10px] font-medium" style={{ background: 'var(--t-bg-active)', color: 'var(--t-text-muted)' }}>{tabs.length}</span>
          <button
            onClick={() => setViewMode(m => m === 'tree' ? 'list' : 'tree')}
            className="p-1 rounded transition-colors"
            style={{
              color: viewMode === 'tree' ? '#6366f1' : 'var(--t-text-faint)',
              background: viewMode === 'tree' ? 'var(--t-bg-active)' : '',
            }}
            title={viewMode === 'tree' ? '切回列表视图' : '按来源链路查看（这个标签是从哪儿点开的）'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="4" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="18" cy="20" r="2" />
              <path d="M6 6v4a3 3 0 003 3h6M9 13v5a3 3 0 003 3h4" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={e => groupTabs(e.shiftKey)}
            disabled={grouping}
            className="p-1.5 rounded transition-colors"
            style={{ color: grouping ? '#6366f1' : 'var(--t-text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
            title="AI 整理（只把没见过的标签送给 AI；按住 Shift 点击可忽略缓存重算）"
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
        onMouseMove={magnifyEnabled
          // 量化到 4px，避免每一次 mousemove 都触发整列表重渲染
          ? e => { const y = Math.round(e.clientY / 4) * 4; setMouseY(prev => prev === y ? prev : y) }
          : undefined}
        onMouseLeave={magnifyEnabled ? () => setMouseY(null) : undefined}
      >
        {loading && (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: 'var(--t-text-muted)' }}>加载中...</div>
        )}

        {!loading && error && (
          <div className="mx-2 mt-2 p-3 rounded bg-red-900/30 text-red-300 text-xs">{error}</div>
        )}

        {!loading && !error && viewMode === 'tree' && (
          <>
            <div className="flex items-center gap-2 mx-3 mt-1 mb-2">
              <div className="h-px flex-1" style={{ background: 'var(--t-border)' }} />
              <span className="text-[10px]" style={{ color: 'var(--t-text-faint)' }}>按来源链路</span>
              <div className="h-px flex-1" style={{ background: 'var(--t-border)' }} />
            </div>
            {treeNodes.map(node => (
              <TabRow
                key={node.tab.id}
                tab={node.tab}
                depth={node.depth}
                hasChildren={node.children.length > 0}
                nodeCollapsed={collapsedNodes.has(node.tab.id)}
                childCount={node.children.length}
                originTitle={node.depth === 0 ? node.origin?.openerTitle : undefined}
                onToggleNode={() => toggleNode(node.tab.id)}
                onCloseSubtree={node.children.length > 0 ? () => closeSubtree(node) : undefined}
                onActivate={() => activateTab(node.tab.id)}
                onClose={() => closeTab(node.tab.id)}
                onPin={() => pinTab(node.tab.id)}
                onCloseOthers={() => closeOtherTabs(node.tab.id)}
                onStash={() => stashTabs([node.tab])}
                onToggleMute={() => toggleMute(node.tab.id)}
                dupCount={dupCount.get(node.tab.url) ?? 1}
                onMergeDuplicates={dupFirstId.get(node.tab.url) === node.tab.id
                  ? () => mergeDuplicates(node.tab.url, node.tab.id) : undefined}
                selected={visibleTabs[cursor]?.id === node.tab.id}
                highlighted={highlighted.has(node.tab.id)}
                mouseY={mouseY}
              />
            ))}
          </>
        )}

        {!loading && !error && viewMode === 'list' && groups.length === 0 && filteredTabs.map(tab => (
          <TabRow
            key={tab.id}
            tab={tab}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onPin={() => pinTab(tab.id)}
            onCloseOthers={() => closeOtherTabs(tab.id)}
            onStash={() => stashTabs([tab])}
            onToggleMute={() => toggleMute(tab.id)}
            dupCount={dupCount.get(tab.url) ?? 1}
            onMergeDuplicates={dupFirstId.get(tab.url) === tab.id
              ? () => mergeDuplicates(tab.url, tab.id) : undefined}
            selected={visibleTabs[cursor]?.id === tab.id}
            highlighted={highlighted.has(tab.id)}
            mouseY={mouseY}
          />
        ))}

        {!loading && !error && viewMode === 'list' && groups.length > 0 && (
          <GroupedTabList
            groups={groups}
            setGroups={setGroups}
            tabs={filteredTabs}
            onActivate={activateTab}
            onClose={closeTab}
            onPin={pinTab}
            onCloseOthers={closeOtherTabs}
            onStash={stashTabs}
            onToggleMute={toggleMute}
            onToggleFocus={toggleFocus}
            focusGroupId={focusGroupId}
            dupCount={dupCount}
            dupFirstId={dupFirstId}
            onMergeDuplicates={mergeDuplicates}
            selectedId={visibleTabs[cursor]?.id}
            highlightedIds={highlighted}
            mouseY={mouseY}
          />
        )}

        {!loading && !error && tabs.length === 0 && (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: 'var(--t-text-muted)' }}>没有打开的标签</div>
        )}
      </div>

      {/* New Tab button */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-2" style={{ borderTop: '1px solid var(--t-border)' }}>
        <button
          onClick={() => chrome.tabs.create({ url: 'chrome://newtab' })}
          className="flex items-center justify-center gap-2 flex-1 py-1.5 rounded text-xs transition-colors"
          style={{ color: 'var(--t-text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建标签页
        </button>
        <button
          onClick={() => setStashOpen(true)}
          className="flex items-center gap-1.5 shrink-0 px-2 py-1.5 rounded text-xs transition-colors"
          style={{ color: stashCount > 0 ? 'var(--t-text-secondary)' : 'var(--t-text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
          title="归档抽屉：关掉但没丢的标签"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
          </svg>
          {stashCount > 0 && <span className="tabular-nums text-[11px]">{stashCount}</span>}
        </button>
        <button
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('perf.html') })}
          className="p-1.5 rounded shrink-0 transition-colors"
          style={{ color: 'var(--t-text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
          title="标签性能"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
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
          onStash={stashSelectedCleanupTabs}
        />
      )}

      {/* 归档抽屉 */}
      {stashOpen && (
        <StashDrawer
          tabs={tabs}
          groups={groups}
          onClose={() => { setStashOpen(false); refreshStashCount() }}
          onChanged={refreshStashCount}
        />
      )}

      {/* 标签助手：浮球 + 对话浮层 */}
      <Assistant
        tabs={tabs}
        groups={groups}
        origins={origins}
        onSelect={highlightTabs}
        onGroup={createGroupFromAssistant}
        onChanged={() => { refreshTabs(); refreshStashCount() }}
        onOpenChange={setAssistantOpen}
      />

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
function TabRow({
  tab, onActivate, onClose, onPin, onCloseOthers, groupAccent, mouseY,
  depth = 0, hasChildren = false, nodeCollapsed = false, childCount = 0,
  originTitle, onToggleNode, onCloseSubtree,
  selected = false, highlighted = false, dupCount = 1, onMergeDuplicates, onToggleMute, onStash,
}: {
  tab: AppTab
  onActivate: () => void
  onClose: () => void
  onPin: () => void
  onCloseOthers: () => void
  groupAccent?: string
  mouseY?: number | null
  selected?: boolean
  /** 被助手指出来的标签 */
  highlighted?: boolean
  dupCount?: number
  onMergeDuplicates?: () => void
  onToggleMute?: () => void
  onStash?: () => void
  // 来源链路视图专用
  depth?: number
  hasChildren?: boolean
  nodeCollapsed?: boolean
  childCount?: number
  originTitle?: string
  onToggleNode?: () => void
  onCloseSubtree?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)

  // 先放迸发彩蛋动画，再真正关闭
  const handleClose = () => {
    if (closing) return
    setClosing(true)
    onClose()
  }

  // 鼠标跟随放大：在 effect 里量位置再写 DOM。
  // 不能在 render 期间读 rowRef.current——那会拿到上一次提交的布局，
  // 该更新时反而不更新。
  useEffect(() => {
    const el = titleRef.current
    const row = rowRef.current
    if (!el || !row) return
    if (mouseY == null) {
      el.style.transform = 'scale(1)'
      return
    }
    const rect = row.getBoundingClientRect()
    const centerY = rect.top + rect.height / 2
    const distance = Math.abs(mouseY - centerY)
    const radius = 80
    const maxScale = 0.25
    el.style.transform = `scale(${distance < radius ? 1 + maxScale * (1 - distance / radius) : 1})`
  }, [mouseY])

  const bgColor = tab.active
    ? 'var(--t-bg-active)'
    : hovered || selected ? 'var(--t-bg-hover)' : 'transparent'

  return (
    <div
      ref={rowRef}
      className={`group relative flex items-center gap-2 px-3 rounded cursor-pointer ${tab.discarded && !closing ? 'opacity-40' : ''} ${highlighted ? 'tab-highlight' : ''}`}
      style={{
        backgroundColor: bgColor,
        minHeight: '32px',
        paddingTop: '5px',
        paddingBottom: '5px',
        paddingLeft: depth > 0 ? `${12 + depth * 13}px` : undefined,
        opacity: closing ? 0 : undefined,
        transform: closing ? 'translateX(10px)' : undefined,
        transition: closing ? 'opacity 300ms ease, transform 300ms ease' : undefined,
      }}
      onClick={onActivate}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenuOpen(false) }}
    >
      {/* Left accent bar for active tab / 键盘光标 */}
      {(tab.active || selected) && (
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r"
          style={{ backgroundColor: tab.active ? (groupAccent ?? '#6366f1') : 'var(--t-text-faint)' }}
        />
      )}

      {/* 来源链路：展开/折叠下级标签 */}
      {hasChildren && (
        <button
          onClick={e => { e.stopPropagation(); onToggleNode?.() }}
          className="w-3 h-3 shrink-0 flex items-center justify-center"
          style={{ color: 'var(--t-text-faint)' }}
          title={nodeCollapsed ? `展开 ${childCount} 个下级标签` : '折叠下级标签'}
        >
          <svg
            width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
            className={`transition-transform ${nodeCollapsed ? '-rotate-90' : ''}`}
          >
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
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
          ref={titleRef}
          style={{ transformOrigin: 'left center', transition: 'transform 0.08s ease', color: tab.active ? 'var(--t-text)' : 'var(--t-text-secondary)' }}
          className={`text-[12px] leading-tight truncate ${tab.pinned ? 'font-medium' : ''}`}
        >
          {tab.title || tab.url || '新标签'}
        </div>
        {/* 来源标签已经被关掉了，这里仍然告诉用户它当初是从哪儿来的 */}
        {originTitle && (
          <div className="text-[9px] leading-tight truncate" style={{ color: 'var(--t-text-faint)' }}>
            来自 {originTitle}
          </div>
        )}
        {nodeCollapsed && childCount > 0 && (
          <div className="text-[9px] leading-tight" style={{ color: 'var(--t-text-faint)' }}>
            折叠了 {childCount} 个下级
          </div>
        )}
      </div>

      {/* 重复标签角标：点一下就把其余同 URL 的标签合掉 */}
      {dupCount > 1 && onMergeDuplicates && (
        <button
          onClick={e => { e.stopPropagation(); onMergeDuplicates() }}
          className="px-1 h-4 shrink-0 rounded text-[9px] font-medium tabular-nums"
          style={{ background: 'rgba(217,138,74,0.18)', color: '#d08a4a' }}
          title={`有 ${dupCount} 个相同页面，点击合并为一个`}
        >
          ×{dupCount}
        </button>
      )}

      {/* 有声音的标签直接就地静音，不用先跳过去找 */}
      {(tab.audible || tab.muted) && onToggleMute && (
        <button
          onClick={e => { e.stopPropagation(); onToggleMute() }}
          className="w-4 h-4 shrink-0 flex items-center justify-center"
          style={{ color: tab.muted ? 'var(--t-text-faint)' : '#6366f1' }}
          title={tab.muted ? '取消静音' : '静音'}
        >
          {tab.muted ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M23 9l-6 6M17 9l6 6" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14" /><path d="M15.54 8.46a5 5 0 010 7.07" />
            </svg>
          )}
        </button>
      )}

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
          {onStash && (
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(false); setClosing(true); onStash() }}
              className="w-full text-left px-3 py-1.5 text-[11px]"
              style={{ color: 'var(--t-text-secondary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              归档并关闭
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onCloseOthers(); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[11px]"
            style={{ color: 'var(--t-text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            关闭其他标签
          </button>
          {onCloseSubtree && (
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(false); onCloseSubtree() }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-red-400"
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              关闭它和 {childCount} 个下级
            </button>
          )}
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

/**
 * 解析每个分组的成员：先按 id，再按 URL 兜底。标签被 Chrome 闲置/冻结后
 * tab id 会变（URL 不变），按 URL 匹配可让分组成员在 id 变化后自愈。
 */
function resolveGroupMembers(groups: VirtualGroup[], tabs: AppTab[]) {
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
  return { groupMembers, ungrouped: tabs.filter(t => !claimed.has(t.id)) }
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
function GroupedTabList({
  groups, setGroups, tabs, onActivate, onClose, onPin, onCloseOthers, mouseY,
  onStash, onToggleMute, onToggleFocus, focusGroupId,
  dupCount, dupFirstId, onMergeDuplicates, selectedId, highlightedIds,
}: {
  groups: VirtualGroup[]
  setGroups: React.Dispatch<React.SetStateAction<VirtualGroup[]>>
  tabs: AppTab[]
  onActivate: (id: number) => void
  onClose: (id: number) => void
  onPin: (id: number) => void
  onCloseOthers: (id: number) => void
  mouseY?: number | null
  onStash: (tabs: AppTab[], groupTitle?: string) => void
  onToggleMute: (id: number) => void
  onToggleFocus: (groupId: string) => void
  focusGroupId: string | null
  dupCount: Map<string, number>
  dupFirstId: Map<string, number>
  onMergeDuplicates: (url: string, keepId: number) => void
  selectedId?: number
  highlightedIds: Set<number>
}) {
  const { groupMembers, ungrouped: ungroupedTabs } = resolveGroupMembers(groups, tabs)

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
              onStash={() => onStash([tab])}
              onToggleMute={() => onToggleMute(tab.id)}
              dupCount={dupCount.get(tab.url) ?? 1}
              onMergeDuplicates={dupFirstId.get(tab.url) === tab.id
                ? () => onMergeDuplicates(tab.url, tab.id) : undefined}
              selected={selectedId === tab.id}
              highlighted={highlightedIds.has(tab.id)}
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
          <div key={group.id} className="mb-3 group/header">
            {/* Group header */}
            <div
              className="flex items-center gap-2 w-full px-3 py-2 rounded transition-colors cursor-pointer"
              onClick={() => toggleGroup(group.id)}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              {/* Colored dot */}
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: accent }} />
              <span className="text-[13px] font-semibold truncate flex-1" style={{ color: 'var(--t-text)' }}>
                {group.title}
              </span>

              <button
                onClick={e => { e.stopPropagation(); onToggleFocus(group.id) }}
                className="w-4 h-4 shrink-0 flex items-center justify-center rounded opacity-0 group-hover/header:opacity-100 transition-opacity"
                style={{ color: focusGroupId === group.id ? '#6366f1' : 'var(--t-text-faint)' }}
                title={focusGroupId === group.id ? '退出专注模式' : '专注这一组：其余标签全部折叠并休眠'}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" />
                </svg>
              </button>
              <button
                onClick={e => { e.stopPropagation(); onStash(groupTabs, group.title) }}
                className="w-4 h-4 shrink-0 flex items-center justify-center rounded opacity-0 group-hover/header:opacity-100 transition-opacity"
                style={{ color: 'var(--t-text-faint)' }}
                title="归档整组：关掉但存起来，随时能恢复"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
                </svg>
              </button>

              <span className="text-[11px] tabular-nums mr-1" style={{ color: 'var(--t-text-muted)' }}>{groupTabs.length}</span>
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-faint)" strokeWidth="2.5"
                className={`transition-transform shrink-0 ${group.collapsed ? '-rotate-90' : ''}`}
              >
                <path d="M18 15l-6-6-6 6" />
              </svg>
            </div>

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
                    onStash={() => onStash([tab], group.title)}
                    onToggleMute={() => onToggleMute(tab.id)}
                    dupCount={dupCount.get(tab.url) ?? 1}
                    onMergeDuplicates={dupFirstId.get(tab.url) === tab.id
                      ? () => onMergeDuplicates(tab.url, tab.id) : undefined}
                    selected={selectedId === tab.id}
                    highlighted={highlightedIds.has(tab.id)}
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
