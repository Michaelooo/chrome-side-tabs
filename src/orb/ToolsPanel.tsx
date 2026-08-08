import { useState, useEffect, useCallback, useRef } from 'react'
import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import { queryTabsInWindow, queryAllTabs } from '../lib/tab-manager'
import { runGrouping, createGroup, buildCleanupItems, loadGroups } from '../lib/tab-tools'
import type { CleanupItem } from '../lib/tab-tools'
import { stash, stashAndClose } from '../lib/stash'
import { provenance } from '../lib/provenance'
import type { TabOrigin } from '../lib/provenance'
import Assistant from '../sidepanel/Assistant'
import CleanupOverlay from '../panels/CleanupOverlay'
import StashDrawer from '../panels/StashDrawer'

// 浮球模式下的工具面板。标签列表交给 Chrome 原生垂直标签栏，
// 这里只放原生没有的那部分：AI 整理、智能清理、归档、助手对话。
// 它是扩展页（嵌在网页里的 iframe，或独立标签页），能直接调 chrome.tabs。

const params = new URLSearchParams(location.search)
const STANDALONE = params.get('standalone') === '1'
/** 性能页的「让 AI 分析」把问题直接带过来，打开就开问 */
const SEED_QUESTION = params.get('ask') ?? undefined

/**
 * 面板嵌在哪个窗口里。内容脚本问不到自己的 tabId，
 * 是 service worker 从 sender.tab.windowId 告诉它、再由它拼进 URL 的。
 * 独立标签页模式下没有这个参数，此时面板自己就是一个顶层扩展页，getCurrent 可信。
 */
async function resolveWindowId(): Promise<number> {
  const fromUrl = params.get('windowId')
  if (fromUrl) return Number(fromUrl)
  const win = await chrome.windows.getCurrent()
  return win.id!
}

// 目标页面的 origin 事先不可知，只能用 *；这些消息不含任何敏感内容
function closeSelf() {
  window.parent.postMessage({ source: 'side-tabs', type: 'close' }, '*')
}

/** 让外面的浮球跟着一起进入忙碌态——面板挡不住浮球，两边不同步会很怪 */
function signalBusy(busy: boolean) {
  window.parent.postMessage({ source: 'side-tabs', type: 'busy', busy }, '*')
}

export default function ToolsPanel() {
  const [windowId, setWindowId] = useState<number | null>(null)
  const [tabs, setTabs] = useState<AppTab[]>([])
  const [groups, setGroups] = useState<VirtualGroup[]>([])
  const [origins, setOrigins] = useState<Record<number, TabOrigin>>({})
  const [stashCount, setStashCount] = useState(0)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [grouping, setGrouping] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupItems, setCleanupItems] = useState<CleanupItem[]>([])
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [stashOpen, setStashOpen] = useState(false)
  // 助手指出来的标签。侧栏里这是列表行高亮，这里没有列表，只能自己列出来
  const [picked, setPicked] = useState<AppTab[]>([])
  const themeLoaded = useRef(false)

  useEffect(() => {
    chrome.storage.local.get('theme').then(({ theme: saved }) => {
      if (saved === 'light' || saved === 'dark') setTheme(saved)
      themeLoaded.current = true
    })
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    if (themeLoaded.current) chrome.storage.local.set({ theme })
  }, [theme])

  const refresh = useCallback(async () => {
    if (windowId == null) return
    setTabs(await queryTabsInWindow(windowId))
    setOrigins(await provenance.getAll())
    setStashCount(await stash.count())
  }, [windowId])

  useEffect(() => {
    resolveWindowId().then(setWindowId)
  }, [])

  useEffect(() => {
    if (windowId == null) return
    refresh()
    loadGroups(windowId).then(saved => { if (saved.length > 0) setGroups(saved) })
  }, [windowId, refresh])

  // 面板开着的时候标签数要跟得上
  useEffect(() => {
    const events = [
      chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated,
      chrome.tabs.onAttached, chrome.tabs.onDetached,
    ]
    let timer: ReturnType<typeof setTimeout>
    const handler = () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    }
    events.forEach(e => e.addListener(handler))
    return () => {
      events.forEach(e => e.removeListener(handler))
      clearTimeout(timer)
    }
  }, [refresh])

  // 焦点在面板里时 ESC 收起整个浮球面板（内容脚本那边收不到这个按键）
  useEffect(() => {
    if (STANDALONE) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (cleanupOpen || stashOpen) return
      closeSelf()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cleanupOpen, stashOpen])

  async function doGroup(forceRefresh = false) {
    if (grouping || windowId == null || tabs.length < 2) return
    setGrouping(true)
    signalBusy(true)
    setStatus(null)
    try {
      const result = await runGrouping(tabs, windowId, { forceRefresh })
      if (result.notConfigured) {
        chrome.runtime.openOptionsPage()
        setStatus('还没配置 AI，已经帮你打开设置页了')
        return
      }
      if (result.error) {
        setStatus(result.error)
        return
      }
      setGroups(result.groups)
      // 分组已经同步进 Chrome 原生标签组了，结果在浏览器自己的标签栏里
      setStatus(result.warning ?? `已整理成 ${result.groups.length} 组，看浏览器标签栏`)
    } finally {
      setGrouping(false)
      signalBusy(false)
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
    const ids = cleanupItems.filter(i => i.selected).map(i => i.id)
    if (ids.length > 0) await chrome.tabs.remove(ids)
    setCleanupOpen(false)
    setCleanupItems([])
    refresh()
  }

  async function stashSelectedCleanupTabs() {
    const ids = new Set(cleanupItems.filter(i => i.selected).map(i => i.id))
    const targets = tabs.filter(t => ids.has(t.id))
    if (targets.length > 0) await stashAndClose(targets)
    setCleanupOpen(false)
    setCleanupItems([])
    refresh()
  }

  async function handleGroupFromAssistant(title: string, color: GroupColor, tabIds: number[]) {
    if (windowId == null) return
    setGroups(await createGroup(windowId, groups, tabs, { title, color, tabIds }))
  }

  // 助手会跨窗口看标签，指出来的可能不在当前窗口，所以查全量再回填
  const handleSelect = useCallback(async (tabIds: number[]) => {
    if (tabIds.length === 0) return
    const byId = new Map((await queryAllTabs()).map(t => [t.id, t]))
    setPicked(tabIds.map(id => byId.get(id)).filter((t): t is AppTab => !!t))
  }, [])

  return (
    <div
      className="flex flex-col h-screen select-none"
      style={{
        background: 'var(--t-bg)',
        color: 'var(--t-text)',
        ...(STANDALONE ? { maxWidth: 420, margin: '0 auto', borderLeft: '1px solid var(--t-border)', borderRight: '1px solid var(--t-border)' } : {}),
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-11 shrink-0" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="flex items-center gap-2">
          {/* 图标的迷你版：两组颜色就是产品语义 */}
          <svg width="14" height="14" viewBox="0 0 16 16" style={{ display: 'block' }}>
            <rect width="16" height="16" rx="3.5" fill="#1e1b4b" />
            <rect x="3" y="4" width="10" height="3" rx="1.5" fill="#22d3ee" />
            <rect x="3" y="9" width="7" height="3" rx="1.5" fill="#a78bfa" />
          </svg>
          <span className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>Sift</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium tabular-nums" style={{ background: 'var(--t-bg-active)', color: 'var(--t-text-muted)' }}>
            {tabs.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            title={theme === 'dark' ? '切换浅色' : '切换深色'}
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
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
          </IconButton>
          <IconButton
            title="标签性能：扫描各标签的内存与资源占用"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('perf.html') })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </IconButton>
          <IconButton title="设置" onClick={() => chrome.runtime.openOptionsPage()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </IconButton>
          {!STANDALONE && (
            <IconButton title="收起（ESC）" onClick={closeSelf}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </IconButton>
          )}
        </div>
      </div>

      {/* 三个动作 */}
      <div className="flex items-center gap-1 px-2 py-2 shrink-0" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <ActionButton
          onClick={e => doGroup(e.shiftKey)}
          busy={grouping}
          label={grouping ? '整理中' : 'AI 整理'}
          title="按语义整理成标签组，结果直接落到浏览器标签栏（按住 Shift 点击可忽略缓存重算）"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2l.5 4 4 .5-4 .5-.5 4-.5-4-4-.5 4-.5z" /><path d="M18 8l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5z" /><path d="M13 16l.5 3 3 .5-3 .5-.5 3-.5-3-3-.5 3-.5z" />
            </svg>
          }
        />
        <ActionButton
          onClick={openCleanup}
          label="清理"
          title="AI 判断哪些标签可以清理，默认动作是归档而非关闭"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" />
            </svg>
          }
        />
        <ActionButton
          onClick={() => setStashOpen(true)}
          label="归档"
          badge={stashCount}
          title="归档抽屉：关掉但没丢的标签、保存的会话、刚关闭的页面"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
            </svg>
          }
        />
      </div>

      {/* 动作结果 */}
      {status && (
        <div
          className="flex items-start gap-2 px-3 py-1.5 shrink-0 text-[10px] leading-relaxed"
          style={{ borderBottom: '1px solid var(--t-border)', color: 'var(--t-text-muted)' }}
        >
          <span className="flex-1">{status}</span>
          <button className="shrink-0" style={{ color: 'var(--t-text-faint)' }} onClick={() => setStatus(null)}>×</button>
        </div>
      )}

      {/* 助手指出来的标签。这里没有列表可以高亮，只能把它们摆出来 */}
      {picked.length > 0 && (
        <div className="shrink-0 px-2 py-1.5" style={{ borderBottom: '1px solid var(--t-border)' }}>
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-[9px]" style={{ color: 'var(--t-text-faint)' }}>助手指出的 {picked.length} 个标签</span>
            <button className="text-[11px] leading-none" style={{ color: 'var(--t-text-faint)' }} onClick={() => setPicked([])}>×</button>
          </div>
          <div className="max-h-24 overflow-y-auto">
            {picked.map(t => (
              <button
                key={t.id}
                onClick={() => { chrome.tabs.update(t.id, { active: true }); chrome.windows.update(t.windowId, { focused: true }) }}
                className="flex items-center gap-2 w-full px-1.5 py-1 rounded text-left"
                style={{ color: 'var(--t-text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
                title={t.url}
              >
                {t.favIconUrl
                  ? <img src={t.favIconUrl} alt="" className="w-3.5 h-3.5 shrink-0 rounded-sm" />
                  : <div className="w-3.5 h-3.5 shrink-0 rounded-sm" style={{ background: 'var(--t-border)' }} />}
                <span className="flex-1 min-w-0 truncate text-[11px]">{t.title || t.url}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 助手：常驻主体 */}
      <Assistant
        embedded
        seedQuestion={SEED_QUESTION}
        tabs={tabs}
        groups={groups}
        origins={origins}
        onSelect={handleSelect}
        onGroup={handleGroupFromAssistant}
        onChanged={refresh}
      />

      {cleanupOpen && (
        <CleanupOverlay
          items={cleanupItems}
          loading={cleanupLoading}
          error={cleanupError}
          onToggle={tabId => setCleanupItems(prev => prev.map(i => i.id === tabId ? { ...i, selected: !i.selected } : i))}
          onClose={() => setCleanupOpen(false)}
          onConfirm={closeSelectedCleanupTabs}
          onStash={stashSelectedCleanupTabs}
        />
      )}

      {stashOpen && (
        <StashDrawer
          tabs={tabs}
          groups={groups}
          onClose={() => { setStashOpen(false); refresh() }}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

function IconButton({ title, onClick, children }: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded transition-colors"
      style={{ color: 'var(--t-text-muted)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = '')}
    >
      {children}
    </button>
  )
}

function ActionButton({ icon, label, title, onClick, busy = false, badge = 0 }: {
  icon: React.ReactNode
  label: string
  title: string
  onClick: (e: React.MouseEvent) => void
  busy?: boolean
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className="flex items-center justify-center gap-1.5 flex-1 py-1.5 rounded text-[11px] transition-colors disabled:opacity-60"
      style={{ color: busy ? '#6366f1' : 'var(--t-text-secondary)', background: 'var(--t-bg-active)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--t-bg-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--t-bg-active)')}
    >
      <span className={busy ? 'animate-spin' : ''} style={{ display: 'flex' }}>{icon}</span>
      {label}
      {badge > 0 && (
        <span className="px-1 rounded text-[9px] tabular-nums" style={{ background: 'var(--t-bg)', color: 'var(--t-text-muted)' }}>
          {badge}
        </span>
      )}
    </button>
  )
}
