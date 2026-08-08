import { useState, useEffect, useCallback } from 'react'
import type { AppTab, VirtualGroup, StashedTab, Session } from '../types/entities'
import { stash, toMarkdown, formatStashedAt } from '../lib/stash'
import { saveSession, restoreSession, deleteSession } from '../lib/session-manager'
import { listRecentlyClosed, restoreSessionId } from '../lib/recently-closed'
import type { ClosedItem } from '../lib/recently-closed'
import { hasPermissions, requestPermissions } from '../lib/permissions'
import { storage } from '../lib/storage'

// 标签囤积的根因不是没整理，是"关掉就找不回来"。归档让关闭这件事不再需要勇气。
export default function StashDrawer({ tabs, groups, onClose, onChanged }: {
  tabs: AppTab[]
  groups: VirtualGroup[]
  onClose: () => void
  onChanged: () => void
}) {
  const [pane, setPane] = useState<'stash' | 'sessions' | 'closed'>('stash')
  const [closed, setClosed] = useState<ClosedItem[]>([])
  const [closedPerm, setClosedPerm] = useState(false)
  const [items, setItems] = useState<StashedTab[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sessionName, setSessionName] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setItems(await stash.list())
    setSessions(await storage.sessions.list())
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([stash.list(), storage.sessions.list()]).then(([s, sess]) => {
      if (cancelled) return
      setItems(s)
      setSessions(sess)
    })
    // 最近关闭需要可选权限，已授权才加载
    hasPermissions(['sessions']).then(async granted => {
      if (cancelled) return
      setClosedPerm(granted)
      if (granted) {
        const list = await listRecentlyClosed()
        if (!cancelled) setClosed(list)
      }
    })
    return () => { cancelled = true }
  }, [])

  // 必须由按钮点击触发，Chrome 要求权限申请在用户手势里
  async function grantClosedPerm() {
    const ok = await requestPermissions(['sessions'])
    if (ok) {
      setClosedPerm(true)
      setClosed(await listRecentlyClosed())
    }
  }

  async function restoreClosedItem(item: ClosedItem) {
    const ok = await restoreSessionId(item.sessionId)
    flash(ok ? `已恢复「${item.title}」` : '恢复失败，记录可能已过期')
    setClosed(await listRecentlyClosed())
    onChanged()
  }

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }

  const filtered = query
    ? items.filter(i =>
        i.title.toLowerCase().includes(query.toLowerCase()) ||
        i.url.toLowerCase().includes(query.toLowerCase()))
    : items

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function restoreSelected() {
    const ids = [...selected]
    if (ids.length === 0) return
    await stash.restore(ids)
    setSelected(new Set())
    await reload()
    onChanged()
  }

  async function removeSelected() {
    const ids = [...selected]
    if (ids.length === 0) return
    await stash.remove(ids)
    setSelected(new Set())
    await reload()
    onChanged()
  }

  async function copyMarkdown() {
    const target = selected.size > 0 ? items.filter(i => selected.has(i.id)) : filtered
    if (target.length === 0) return
    await navigator.clipboard.writeText(toMarkdown(target))
    flash(`已复制 ${target.length} 条为 Markdown`)
  }

  async function doSaveSession() {
    const name = sessionName.trim() || new Date().toLocaleString('zh-CN')
    await saveSession(name, tabs, groups)
    setSessionName('')
    await reload()
    flash(`已保存会话「${name}」`)
  }

  return (
    <div className="absolute inset-0 z-50 bg-black/50 flex items-start justify-center pt-6" onClick={onClose}>
      <div
        className="w-[calc(100%-12px)] max-h-[calc(100%-48px)] rounded-lg border shadow-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--t-bg-active)', borderColor: 'var(--t-border)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--t-border)' }}>
          <div className="flex items-center gap-1">
            {(['stash', 'sessions', 'closed'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPane(p)}
                className="px-2 py-1 rounded text-[11px]"
                style={{
                  background: pane === p ? 'var(--t-bg-hover)' : 'transparent',
                  color: pane === p ? 'var(--t-text)' : 'var(--t-text-muted)',
                }}
              >
                {p === 'stash' ? `归档 ${items.length}`
                  : p === 'sessions' ? `会话 ${sessions.length}`
                  : closedPerm ? `刚关闭 ${closed.length}` : '刚关闭'}
              </button>
            ))}
          </div>
          <button className="p-1 rounded" style={{ color: 'var(--t-text-muted)' }} onClick={onClose}>×</button>
        </div>

        {pane === 'stash' && (
          <>
            <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--t-border)' }}>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索归档..."
                className="w-full bg-transparent text-xs focus:outline-none"
                style={{ color: 'var(--t-text)' }}
              />
            </div>

            <div className="overflow-y-auto flex-1 p-2">
              {filtered.length === 0 && (
                <div className="py-8 px-4 text-center">
                  <div className="text-xs mb-1" style={{ color: 'var(--t-text-muted)' }}>
                    {items.length === 0 ? '归档是空的' : '没有匹配的归档'}
                  </div>
                  {items.length === 0 && (
                    <div className="text-[10px] leading-relaxed" style={{ color: 'var(--t-text-faint)' }}>
                      在标签右键菜单里选「归档并关闭」，或在分组标题上点归档图标。
                      归档过的页面随时能一键恢复，所以关标签不用再犹豫。
                    </div>
                  )}
                </div>
              )}
              {filtered.map(item => (
                <label key={item.id} className="flex gap-2 p-1.5 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    className="mt-1 shrink-0"
                  />
                  {item.favIconUrl ? (
                    <img src={item.favIconUrl} alt="" className="w-3.5 h-3.5 mt-0.5 shrink-0 rounded-sm" />
                  ) : (
                    <div className="w-3.5 h-3.5 mt-0.5 shrink-0 rounded-sm" style={{ background: 'var(--t-border)' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] truncate" style={{ color: 'var(--t-text)' }}>{item.title}</div>
                    <div className="flex items-center gap-1.5 text-[9px]" style={{ color: 'var(--t-text-faint)' }}>
                      <span>{formatStashedAt(item.stashedAt)}</span>
                      {item.groupTitle && <span>· {item.groupTitle}</span>}
                      {item.auto && <span>· 自动归档</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--t-border)' }}>
              <span className="text-[10px]" style={{ color: 'var(--t-text-muted)' }}>
                {toast ?? (selected.size > 0 ? `已选 ${selected.size} 条` : '选中后可恢复或导出')}
              </span>
              <div className="flex gap-1">
                <button
                  className="px-2 py-1.5 rounded text-[11px]"
                  style={{ color: 'var(--t-text-muted)' }}
                  onClick={copyMarkdown}
                >
                  复制 MD
                </button>
                <button
                  className="px-2 py-1.5 rounded text-[11px] disabled:opacity-40"
                  style={{ color: '#ef4444' }}
                  disabled={selected.size === 0}
                  onClick={removeSelected}
                >
                  删除
                </button>
                <button
                  className="px-3 py-1.5 rounded text-[11px] disabled:opacity-40"
                  style={{ background: '#6366f1', color: '#fff' }}
                  disabled={selected.size === 0}
                  onClick={restoreSelected}
                >
                  恢复
                </button>
              </div>
            </div>
          </>
        )}

        {pane === 'sessions' && (
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--t-border)' }}>
              <input
                value={sessionName}
                onChange={e => setSessionName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') doSaveSession() }}
                placeholder="会话名称（留空用当前时间）"
                className="flex-1 bg-transparent text-xs focus:outline-none"
                style={{ color: 'var(--t-text)' }}
              />
              <button
                className="px-2 py-1 rounded text-[11px] shrink-0"
                style={{ background: '#6366f1', color: '#fff' }}
                onClick={doSaveSession}
              >
                保存当前
              </button>
            </div>

            <div className="overflow-y-auto flex-1 p-2">
              {sessions.length === 0 && (
                <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>
                  还没有保存过会话
                </div>
              )}
              {sessions.map(s => (
                <div key={s.id} className="flex items-center gap-2 p-2 rounded">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] truncate" style={{ color: 'var(--t-text)' }}>{s.name}</div>
                    <div className="text-[9px]" style={{ color: 'var(--t-text-faint)' }}>
                      {s.tabs.length} 个标签 · {formatStashedAt(s.createdAt)}
                    </div>
                  </div>
                  <button
                    className="px-2 py-1 rounded text-[10px] shrink-0"
                    style={{ background: 'var(--t-bg-hover)', color: 'var(--t-text-secondary)' }}
                    onClick={async () => { await restoreSession(s.id); flash(`已恢复「${s.name}」`) }}
                  >
                    恢复
                  </button>
                  <button
                    className="px-2 py-1 rounded text-[10px] shrink-0"
                    style={{ color: '#ef4444' }}
                    onClick={async () => { await deleteSession(s.id); await reload() }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>

            {toast && (
              <div className="px-3 py-2 border-t text-[10px]" style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}>
                {toast}
              </div>
            )}
          </>
        )}

        {/* 刚关闭：归档管有意关的，这里管手滑关的 */}
        {pane === 'closed' && (
          <>
            <div className="overflow-y-auto flex-1 p-2">
              {!closedPerm && (
                <div className="py-6 px-4 text-center">
                  <div className="text-xs mb-2" style={{ color: 'var(--t-text-secondary)' }}>
                    找回误关的标签页
                  </div>
                  <div className="text-[10px] leading-relaxed mb-3" style={{ color: 'var(--t-text-faint)' }}>
                    需要「最近关闭的标签」权限，只在你打开这个页签时读取，不会上传。
                    授权一次长期有效，可随时在设置页收回。
                  </div>
                  <button
                    className="px-3 py-1.5 rounded text-[11px]"
                    style={{ background: '#6366f1', color: '#fff' }}
                    onClick={grantClosedPerm}
                  >
                    授权并查看
                  </button>
                </div>
              )}
              {closedPerm && closed.length === 0 && (
                <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>
                  最近没有关闭过标签
                </div>
              )}
              {closedPerm && closed.map(item => (
                <div key={item.sessionId} className="flex items-center gap-2 p-2 rounded">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] truncate" style={{ color: 'var(--t-text)' }}>{item.title}</div>
                    <div className="flex items-center gap-1.5 text-[9px]" style={{ color: 'var(--t-text-faint)' }}>
                      <span>{formatStashedAt(item.closedAt)}关闭</span>
                      {item.url && <span className="truncate">· {item.url}</span>}
                    </div>
                  </div>
                  <button
                    className="px-2 py-1 rounded text-[10px] shrink-0"
                    style={{ background: 'var(--t-bg-hover)', color: 'var(--t-text-secondary)' }}
                    onClick={() => restoreClosedItem(item)}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>

            {toast && (
              <div className="px-3 py-2 border-t text-[10px]" style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}>
                {toast}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
