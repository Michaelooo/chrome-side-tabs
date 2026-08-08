import { useState, useEffect, useCallback, useMemo } from 'react'
import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import { storage } from '../lib/storage'
import { provenance } from '../lib/provenance'
import { stash } from '../lib/stash'
import type { TabOrigin } from '../lib/provenance'
import {
  scanTabs, getSiteKey, getHostname,
  formatBytes, formatCount, formatIdle,
} from '../lib/perf-probe'
import type { TabMetrics, ScanStats } from '../lib/perf-probe'
import { putScan } from '../lib/perf-store'

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

type SortKey = 'weight' | 'waste' | 'jsHeap' | 'imgBitmapBytes' | 'domNodes'

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'weight', label: '重量分' },
  { key: 'waste', label: '浪费分' },
  { key: 'imgBitmapBytes', label: '图片位图' },
  { key: 'jsHeap', label: 'JS 堆' },
  { key: 'domNodes', label: 'DOM 节点' },
]

async function queryAllTabs(): Promise<AppTab[]> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true })
  const out: AppTab[] = []
  for (const win of windows) {
    for (const t of win.tabs ?? []) {
      if (t.id == null) continue
      out.push({
        id: t.id,
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
      })
    }
  }
  return out
}

export default function PerfApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [tabs, setTabs] = useState<AppTab[]>([])
  const [metrics, setMetrics] = useState<TabMetrics[]>([])
  const [stats, setStats] = useState<ScanStats | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [sortKey, setSortKey] = useState<SortKey>('weight')
  const [groups, setGroups] = useState<VirtualGroup[]>([])
  const [origins, setOrigins] = useState<Record<number, TabOrigin>>({})
  const [stashCount, setStashCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    chrome.storage.local.get('theme').then(({ theme: saved }) => {
      if (saved === 'light' || saved === 'dark') setTheme(saved)
    })
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
  }, [theme])

  const loadTabs = useCallback(async () => {
    setTabs(await queryAllTabs())
  }, [])

  useEffect(() => { loadTabs() }, [loadTabs])

  // 侧栏的分组是按窗口存的，这里把所有窗口的分组都取出来做聚合
  useEffect(() => {
    async function loadGroups() {
      const wins = await chrome.windows.getAll({ windowTypes: ['normal'] })
      const all: VirtualGroup[] = []
      for (const w of wins) {
        if (w.id != null) all.push(...await storage.groups.get(w.id))
      }
      setGroups(all)
    }
    loadGroups()
    provenance.getAll().then(setOrigins)
    stash.count().then(setStashCount)
  }, [])

  const runScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    setError(null)
    try {
      const current = await queryAllTabs()
      // 不测量性能页自己
      const self = await chrome.tabs.getCurrent()
      const targets = current.filter(t => t.id !== self?.id)
      setTabs(current)
      setProgress({ done: 0, total: targets.length })
      const result = await scanTabs(targets, (done, total) => setProgress({ done, total }))
      setMetrics(result.metrics)
      setStats(result.stats)
      // 存进会话缓存，AI 助手问起占用时直接复用，不用把所有标签重扫一遍
      await putScan(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setScanning(false)
    }
  }, [scanning])

  // 扫描结果已经在会话缓存里，这里只把话题带过去。
  // 助手那边的 scanPerf 查询会复用同一份缓存，不会把所有标签重扫一遍。
  function askAI() {
    const q = '分析一下这些标签的占用：哪些最重、哪些又重又没人看？该关掉或休眠哪些最划算？'
    chrome.tabs.create({
      url: chrome.runtime.getURL(`orb.html?standalone=1&ask=${encodeURIComponent(q)}`),
    })
  }

  const measured = useMemo(() => metrics.filter(m => m.measured), [metrics])
  const unmeasured = useMemo(() => metrics.filter(m => !m.measured), [metrics])

  const sorted = useMemo(
    () => [...measured].sort((a, b) => b[sortKey] - a[sortKey]),
    [measured, sortKey],
  )

  const maxOfSort = sorted.length ? sorted[0][sortKey] || 1 : 1

  const totals = useMemo(() => ({
    imgBitmapBytes: measured.reduce((s, m) => s + m.imgBitmapBytes, 0),
    jsHeap: measured.reduce((s, m) => s + m.jsHeap, 0),
    domNodes: measured.reduce((s, m) => s + m.domNodes, 0),
    iframes: measured.reduce((s, m) => s + m.iframes, 0),
  }), [measured])

  // 同 site 的标签共用渲染进程，把它们归到一起展示
  const siteClusters = useMemo(() => {
    const map = new Map<string, TabMetrics[]>()
    for (const m of measured) {
      const key = getSiteKey(m.url)
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([site, list]) => ({
        site,
        list,
        weight: list.reduce((s, m) => s + m.weight, 0),
      }))
      .sort((a, b) => b.weight - a.weight)
  }, [measured])

  // 分组维度聚合。成员按 tabId 认领，认不到再按 URL 兜底，
  // 和侧栏里处理标签 id 变化的逻辑保持一致。
  const groupAgg = useMemo(() => {
    const byId = new Map(measured.map(m => [m.tabId, m]))
    const claimed = new Set<number>()
    return groups
      .map(g => {
        const members: TabMetrics[] = []
        for (const id of g.tabIds) {
          const m = byId.get(id)
          if (m && !claimed.has(m.tabId)) { members.push(m); claimed.add(m.tabId) }
        }
        if (g.tabUrls?.length) {
          const urlSet = new Set(g.tabUrls)
          for (const m of measured) {
            if (!claimed.has(m.tabId) && urlSet.has(m.url)) { members.push(m); claimed.add(m.tabId) }
          }
        }
        return {
          group: g,
          members,
          weight: members.reduce((s, m) => s + m.weight, 0),
          imgBitmapBytes: members.reduce((s, m) => s + m.imgBitmapBytes, 0),
          jsHeap: members.reduce((s, m) => s + m.jsHeap, 0),
          domNodes: members.reduce((s, m) => s + m.domNodes, 0),
        }
      })
      .filter(x => x.members.length > 0)
      .sort((a, b) => b.weight - a.weight)
  }, [groups, measured])

  const wasteful = useMemo(
    () => [...measured].filter(m => m.waste > 0).sort((a, b) => b.waste - a.waste).slice(0, 8),
    [measured],
  )

  const suspendedCount = tabs.filter(t => t.discarded).length

  // 注意力账单：openerTabId 记录里带着创建时间，
  // 如果一个标签的 lastAccessed 和 createdAt 几乎相同，说明它打开之后就再没被回访过。
  const attention = useMemo(() => {
    const tracked = tabs.filter(t => origins[t.id]?.createdAt)
    const neverRevisited = tracked.filter(t => {
      const created = origins[t.id].createdAt
      return t.lastAccessed - created < 60000 && Date.now() - created > 30 * 60000
    })
    const idleHours = tabs
      .filter(t => !t.active)
      .map(t => (Date.now() - t.lastAccessed) / 3600000)
    const avgIdle = idleHours.length ? idleHours.reduce((a, b) => a + b, 0) / idleHours.length : 0

    const byHost = new Map<string, number>()
    for (const t of tabs) {
      if (!t.url) continue
      const host = getHostname(t.url)
      byHost.set(host, (byHost.get(host) ?? 0) + 1)
    }
    const topHosts = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)

    return { tracked: tracked.length, neverRevisited: neverRevisited.length, avgIdle, topHosts }
  }, [tabs, origins])

  async function closeTabs(ids: number[]) {
    if (ids.length === 0) return
    await chrome.tabs.remove(ids)
    setMetrics(prev => prev.filter(m => !ids.includes(m.tabId)))
    await loadTabs()
  }

  async function discardTabs(ids: number[]) {
    for (const id of ids) {
      try { await chrome.tabs.discard(id) } catch { /* 标签可能已关闭 */ }
    }
    setMetrics(prev => prev.filter(m => !ids.includes(m.tabId)))
    await loadTabs()
  }

  // 归档：关掉但不丢。比直接关闭安全，用户不用纠结"万一还要用"
  async function stashTabs(ids: number[]) {
    if (ids.length === 0) return
    const targets = tabs.filter(t => ids.includes(t.id) && t.url && !t.url.startsWith('chrome://'))
    if (targets.length === 0) return
    await stash.add(targets.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })))
    await chrome.tabs.remove(targets.map(t => t.id))
    setMetrics(prev => prev.filter(m => !ids.includes(m.tabId)))
    setStashCount(await stash.count())
    await loadTabs()
  }

  async function activate(tabId: number) {
    const tab = await chrome.tabs.get(tabId)
    await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tabId, { active: true })
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--t-bg)', color: 'var(--t-text)' }}>
      <div className="max-w-[1100px] mx-auto px-6 py-6">

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-lg font-semibold m-0">标签性能</h1>
            <p className="text-xs mt-1 mb-0" style={{ color: 'var(--t-text-muted)' }}>
              按需扫描，不驻留任何后台代码。共 {tabs.length} 个标签
              {suspendedCount > 0 && `，其中 ${suspendedCount} 个已休眠`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              className="px-3 py-2 rounded text-xs"
              style={{ background: 'var(--t-bg-active)', color: 'var(--t-text-muted)' }}
            >
              {theme === 'dark' ? '浅色' : '深色'}
            </button>
            {metrics.length > 0 && !scanning && (
              <button
                onClick={askAI}
                className="px-3 py-2 rounded text-xs"
                style={{ background: 'var(--t-bg-active)', color: 'var(--t-text-secondary)' }}
                title="把这份扫描结果交给 AI 助手，让它给出该关掉/休眠哪些的建议"
              >
                让 AI 分析
              </button>
            )}
            <button
              onClick={runScan}
              disabled={scanning}
              className="px-4 py-2 rounded text-xs font-medium disabled:opacity-50"
              style={{ background: '#6366f1', color: '#fff' }}
            >
              {scanning ? `扫描中 ${progress.done}/${progress.total}` : metrics.length ? '重新扫描' : '开始扫描'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded text-xs bg-red-900/30 text-red-300">{error}</div>
        )}

        {metrics.length === 0 && !scanning && (
          <EmptyState onScan={runScan} tabCount={tabs.length} />
        )}

        {stats && (
          <>
            {/* 扫描开销 —— 这个功能自己花了多少代价，直接摊开给你看 */}
            <Section title="本次扫描的开销">
              <div className="grid grid-cols-4 gap-3">
                <Stat label="总耗时（墙钟）" value={`${stats.wallClockMs} ms`} hint="并发 5 路" />
                <Stat
                  label="平均每标签占用主线程"
                  value={`${stats.avgProbeMs.toFixed(2)} ms`}
                  hint="探针纯执行时间"
                  good={stats.avgProbeMs < 16}
                />
                <Stat
                  label="最重的一个标签"
                  value={`${stats.maxProbeMs.toFixed(2)} ms`}
                  hint="单标签峰值"
                  good={stats.maxProbeMs < 50}
                />
                <Stat
                  label="所有标签合计"
                  value={`${stats.totalProbeMs} ms`}
                  hint={`${stats.measured} 个标签一次性`}
                />
              </div>
              <p className="text-[11px] leading-relaxed mt-3 mb-0" style={{ color: 'var(--t-text-faint)' }}>
                探针是一次性注入、执行完立即消失，不注册监听器、不轮询、不在 manifest 里声明 content script。
                不点扫描按钮时，这个功能的常驻开销是 0。
                {stats.skipped > 0 && ` 已跳过 ${stats.skipped} 个无法测量或已休眠的标签（休眠标签注入会把它唤醒，反而更耗资源）。`}
              </p>
            </Section>

            {/* 注意力账单 */}
            <Section title="注意力账单">
              <div className="grid grid-cols-4 gap-3">
                <Stat
                  label="打开后再没回访过"
                  value={attention.tracked > 0 ? `${attention.neverRevisited} 个` : '数据积累中'}
                  hint={attention.tracked > 0 ? `已追踪 ${attention.tracked} 个标签` : '需要重开标签才有记录'}
                />
                <Stat label="平均闲置时长" value={`${attention.avgIdle.toFixed(1)} 小时`} />
                <Stat label="已归档" value={`${stashCount} 个`} hint="关掉但没丢的" />
                <Stat
                  label="标签黑洞"
                  value={attention.topHosts[0] ? attention.topHosts[0][0] : '—'}
                  hint={attention.topHosts[0] ? `贡献了 ${attention.topHosts[0][1]} 个标签` : undefined}
                />
              </div>
              {attention.topHosts.length > 1 && (
                <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--t-text-faint)' }}>
                  开得最多的站点：{attention.topHosts.map(([h, n]) => `${h}（${n}）`).join('、')}
                </p>
              )}
            </Section>

            {/* 概览 */}
            <Section title="总量概览">
              <div className="grid grid-cols-4 gap-3">
                <Stat label="图片解码位图（估算）" value={formatBytes(totals.imgBitmapBytes)} hint="通常是内存大头" />
                <Stat label="JS 堆合计" value={formatBytes(totals.jsHeap)} hint="同进程标签会低估" />
                <Stat label="DOM 节点合计" value={formatCount(totals.domNodes)} />
                <Stat label="内嵌 iframe" value={formatCount(totals.iframes)} hint="跨域 iframe 独占进程" />
              </div>
            </Section>

            {/* 可行动建议 */}
            {wasteful.length > 0 && (
              <Section title="最值得处理的标签">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] m-0" style={{ color: 'var(--t-text-muted)' }}>
                    浪费分 = 重量分 × 闲置程度。这 {wasteful.length} 个标签又重又久没碰过。
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => discardTabs(wasteful.map(m => m.tabId))}
                      className="px-3 py-1.5 rounded text-[11px]"
                      style={{ background: 'var(--t-bg-active)', color: 'var(--t-text-secondary)' }}
                    >
                      全部休眠
                    </button>
                    <button
                      onClick={() => stashTabs(wasteful.map(m => m.tabId))}
                      className="px-3 py-1.5 rounded text-[11px]"
                      style={{ background: '#6366f1', color: '#fff' }}
                      title="关掉但存进归档，随时能恢复"
                    >
                      全部归档
                    </button>
                    <button
                      onClick={() => closeTabs(wasteful.map(m => m.tabId))}
                      className="px-3 py-1.5 rounded text-[11px]"
                      style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
                    >
                      全部关闭
                    </button>
                  </div>
                </div>
                <div className="rounded overflow-hidden" style={{ border: '1px solid var(--t-border)' }}>
                  {wasteful.map(m => (
                    <MetricRow
                      key={m.tabId}
                      m={m}
                      barValue={m.waste}
                      barMax={wasteful[0].waste || 1}
                      barLabel={`浪费 ${m.waste}`}
                      onActivate={() => activate(m.tabId)}
                      onDiscard={() => discardTabs([m.tabId])}
                      onStash={() => stashTabs([m.tabId])}
                      onClose={() => closeTabs([m.tabId])}
                    />
                  ))}
                </div>
              </Section>
            )}

            {/* 分组维度 */}
            {groupAgg.length > 0 && (
              <Section title="按分组统计">
                <div className="rounded overflow-hidden" style={{ border: '1px solid var(--t-border)' }}>
                  {groupAgg.map(g => {
                    const accent = GROUP_ACCENT[g.group.color] ?? GROUP_ACCENT.blue
                    const max = groupAgg[0].weight || 1
                    return (
                      <div
                        key={g.group.id}
                        className="group relative flex items-center gap-3 px-3 py-2"
                        style={{ borderBottom: '1px solid var(--t-border)' }}
                      >
                        <div
                          className="absolute left-0 top-0 bottom-0 pointer-events-none"
                          style={{ width: `${Math.max(2, (g.weight / max) * 100)}%`, background: `${accent}1f` }}
                        />
                        <div className="w-2 h-2 rounded-full shrink-0 relative" style={{ background: accent }} />
                        <div className="min-w-0 flex-1 relative">
                          <div className="text-xs" style={{ color: 'var(--t-text)' }}>{g.group.title}</div>
                          <div className="text-[10px]" style={{ color: 'var(--t-text-faint)' }}>
                            {g.members.length} 个标签
                          </div>
                        </div>
                        <div className="hidden lg:flex items-center gap-4 shrink-0 relative text-[10px] tabular-nums">
                          <Cell label="位图" value={formatBytes(g.imgBitmapBytes)} />
                          <Cell label="JS 堆" value={formatBytes(g.jsHeap)} />
                          <Cell label="DOM" value={formatCount(g.domNodes)} />
                        </div>
                        <div className="w-[76px] text-right shrink-0 relative">
                          <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--t-text)' }}>
                            重量 {g.weight}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0 relative opacity-0 group-hover:opacity-100 transition-opacity">
                          <RowButton onClick={() => discardTabs(g.members.map(m => m.tabId))} title="休眠整组">休眠</RowButton>
                          <RowButton onClick={() => closeTabs(g.members.map(m => m.tabId))} title="关闭整组" danger>关闭</RowButton>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--t-text-faint)' }}>
                  分组的重量是成员之和。注意同组标签如果同属一个站点，实际内存是共享的，这里的加总会偏高。
                </p>
              </Section>
            )}

            {/* 进程共享 */}
            {siteClusters.length > 0 && (
              <Section title="共用渲染进程的标签">
                <p className="text-[11px] mt-0 mb-2" style={{ color: 'var(--t-text-muted)' }}>
                  Chrome 按站点隔离进程，同站点的标签共用一个进程、内存互相共享。
                  这是任务管理器里那个数字难读的根本原因：它是进程视角，不是标签视角。
                  下面的站点划分是按主域名近似的。
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {siteClusters.slice(0, 6).map(c => (
                    <div key={c.site} className="p-3 rounded" style={{ border: '1px solid var(--t-border)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium truncate">{c.site.replace(/^https?:\/\//, '')}</span>
                        <span className="text-[10px] shrink-0 ml-2" style={{ color: 'var(--t-text-muted)' }}>
                          {c.list.length} 个标签 · 合计重量 {c.weight}
                        </span>
                      </div>
                      {c.list.slice(0, 4).map(m => (
                        <div key={m.tabId} className="flex items-center gap-2 py-0.5">
                          <span className="text-[11px] truncate flex-1" style={{ color: 'var(--t-text-secondary)' }}>
                            {m.title}
                          </span>
                          <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'var(--t-text-faint)' }}>
                            {m.weight}
                          </span>
                        </div>
                      ))}
                      {c.list.length > 4 && (
                        <div className="text-[10px] mt-1" style={{ color: 'var(--t-text-faint)' }}>
                          还有 {c.list.length - 4} 个
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* 全部标签 */}
            <Section title={`全部标签（${sorted.length}）`}>
              <div className="flex items-center gap-1 mb-2">
                <span className="text-[11px] mr-1" style={{ color: 'var(--t-text-muted)' }}>排序</span>
                {SORT_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setSortKey(opt.key)}
                    className="px-2 py-1 rounded text-[11px]"
                    style={{
                      background: sortKey === opt.key ? 'var(--t-bg-active)' : 'transparent',
                      color: sortKey === opt.key ? 'var(--t-text)' : 'var(--t-text-muted)',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="rounded overflow-hidden" style={{ border: '1px solid var(--t-border)' }}>
                {sorted.map(m => (
                  <MetricRow
                    key={m.tabId}
                    m={m}
                    barValue={m[sortKey]}
                    barMax={maxOfSort}
                    barLabel={
                      sortKey === 'weight' ? `重量 ${m.weight}`
                        : sortKey === 'waste' ? `浪费 ${m.waste}`
                        : sortKey === 'domNodes' ? `${formatCount(m.domNodes)} 节点`
                        : formatBytes(m[sortKey])
                    }
                    onActivate={() => activate(m.tabId)}
                    onDiscard={() => discardTabs([m.tabId])}
                    onStash={() => stashTabs([m.tabId])}
                    onClose={() => closeTabs([m.tabId])}
                  />
                ))}
              </div>
            </Section>

            {/* 不可测量 */}
            {unmeasured.length > 0 && (
              <Section title={`未测量（${unmeasured.length}）`}>
                <div className="rounded overflow-hidden" style={{ border: '1px solid var(--t-border)' }}>
                  {unmeasured.map(m => (
                    <div
                      key={m.tabId}
                      className="flex items-center gap-3 px-3 py-2"
                      style={{ borderBottom: '1px solid var(--t-border)' }}
                    >
                      <span className="text-xs truncate flex-1" style={{ color: 'var(--t-text-secondary)' }}>
                        {m.title}
                      </span>
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--t-text-faint)' }}>
                        {m.skipReason}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function EmptyState({ onScan, tabCount }: { onScan: () => void; tabCount: number }) {
  return (
    <div className="rounded-lg p-8 text-center" style={{ border: '1px dashed var(--t-border)' }}>
      <p className="text-sm mb-2" style={{ color: 'var(--t-text-secondary)' }}>
        还没有扫描数据
      </p>
      <p className="text-xs leading-relaxed max-w-[520px] mx-auto mb-4" style={{ color: 'var(--t-text-muted)' }}>
        点击扫描会往 {tabCount} 个标签各注入一次探针，读取 DOM 节点数、图片解码位图、JS 堆和资源体积，
        执行完立刻销毁。已休眠的标签会被跳过，避免把它们唤醒。
        扫描完成后这里会显示探针自身的耗时，你可以直接看到它的代价。
      </p>
      <button onClick={onScan} className="px-4 py-2 rounded text-xs font-medium" style={{ background: '#6366f1', color: '#fff' }}>
        开始扫描
      </button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-xs font-semibold mb-2 mt-0" style={{ color: 'var(--t-text-muted)' }}>{title}</h2>
      {children}
    </div>
  )
}

function Stat({ label, value, hint, good }: { label: string; value: string; hint?: string; good?: boolean }) {
  return (
    <div className="p-3 rounded" style={{ background: 'var(--t-bg-active)' }}>
      <div className="text-[10px] mb-1" style={{ color: 'var(--t-text-muted)' }}>{label}</div>
      <div className="text-base font-semibold tabular-nums" style={{ color: good ? '#22c55e' : 'var(--t-text)' }}>
        {value}
      </div>
      {hint && <div className="text-[10px] mt-0.5" style={{ color: 'var(--t-text-faint)' }}>{hint}</div>}
    </div>
  )
}

function MetricRow({ m, barValue, barMax, barLabel, onActivate, onDiscard, onStash, onClose }: {
  m: TabMetrics
  barValue: number
  barMax: number
  barLabel: string
  onActivate: () => void
  onDiscard: () => void
  onStash: () => void
  onClose: () => void
}) {
  const pct = barMax > 0 ? Math.max(2, (barValue / barMax) * 100) : 2

  return (
    <div
      className="group relative flex items-center gap-3 px-3 py-2"
      style={{ borderBottom: '1px solid var(--t-border)' }}
    >
      {/* 背景条 */}
      <div
        className="absolute left-0 top-0 bottom-0 pointer-events-none"
        style={{ width: `${pct}%`, background: 'rgba(99,102,241,0.10)' }}
      />

      {m.favIconUrl ? (
        <img src={m.favIconUrl} alt="" className="w-4 h-4 rounded-sm shrink-0 relative" />
      ) : (
        <div className="w-4 h-4 rounded-sm shrink-0 relative" style={{ background: 'var(--t-border)' }} />
      )}

      <div className="min-w-0 flex-1 relative">
        <div className="text-xs truncate" style={{ color: 'var(--t-text)' }}>{m.title}</div>
        <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--t-text-faint)' }}>
          <span className="truncate">{getHostname(m.url)}</span>
          <span>·</span>
          <span className="shrink-0">{formatIdle(m.lastAccessed)}</span>
          {m.pinned && <span className="shrink-0">· 已固定</span>}
          {m.audible && <span className="shrink-0">· 有声音</span>}
          {m.frames > 1 && <span className="shrink-0">· {m.frames} 个 frame</span>}
        </div>
      </div>

      <div className="hidden lg:flex items-center gap-4 shrink-0 relative text-[10px] tabular-nums" style={{ color: 'var(--t-text-muted)' }}>
        <Cell label="位图" value={formatBytes(m.imgBitmapBytes)} />
        <Cell label="JS 堆" value={m.jsHeapAvailable ? formatBytes(m.jsHeap) : '不可用'} />
        <Cell label="DOM" value={formatCount(m.domNodes)} />
        <Cell label="传输" value={formatBytes(m.transferBytes)} />
      </div>

      <div className="w-[76px] text-right shrink-0 relative">
        <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--t-text)' }}>{barLabel}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0 relative opacity-0 group-hover:opacity-100 transition-opacity">
        <RowButton onClick={onActivate} title="跳转到该标签">跳转</RowButton>
        <RowButton onClick={onDiscard} title="休眠该标签，释放内存但保留标签">休眠</RowButton>
        <RowButton onClick={onStash} title="归档：关掉但存起来，随时能恢复">归档</RowButton>
        <RowButton onClick={onClose} title="关闭该标签" danger>关闭</RowButton>
      </div>
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="w-[62px] text-right">
      <div style={{ color: 'var(--t-text-faint)' }}>{label}</div>
      <div style={{ color: 'var(--t-text-secondary)' }}>{value}</div>
    </div>
  )
}

function RowButton({ onClick, title, danger, children }: {
  onClick: () => void
  title: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-2 py-1 rounded text-[10px]"
      style={{
        background: danger ? 'rgba(239,68,68,0.15)' : 'var(--t-bg-active)',
        color: danger ? '#ef4444' : 'var(--t-text-secondary)',
      }}
    >
      {children}
    </button>
  )
}
