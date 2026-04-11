import { useState, useEffect } from 'react'
import { sendMessage } from '../../lib/messaging'
import type { Session } from '../../types/entities'

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadSessions()
  }, [])

  async function loadSessions() {
    const res = await sendMessage({ type: 'getSessions' })
    if (res.success && res.data) setSessions(res.data as Session[])
  }

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    const win = await chrome.windows.getCurrent()
    await sendMessage({ type: 'saveSession', name: name.trim(), windowId: win.id! })
    setName('')
    setSaving(false)
    await loadSessions()
  }

  async function handleRestore(id: string) {
    await sendMessage({ type: 'restoreSession', sessionId: id })
    await loadSessions()
  }

  async function handleDelete(id: string) {
    await sendMessage({ type: 'deleteSession', sessionId: id })
    await loadSessions()
  }

  return (
    <div className="flex flex-col h-full p-3">
      <h2 className="text-sm font-semibold mb-3">会话管理</h2>

      <div className="flex gap-2 mb-3">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="会话名称"
          className="flex-1 px-2 py-1.5 rounded bg-[var(--color-bg-secondary)] text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
          onKeyDown={e => e.key === 'Enter' && handleSave()}
        />
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="px-3 py-1.5 rounded bg-[var(--color-accent)] text-white text-sm disabled:opacity-50 hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          保存
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {sessions.map(s => (
          <div key={s.id} className="flex items-center justify-between p-2 rounded bg-[var(--color-bg-secondary)]">
            <div>
              <div className="text-sm font-medium">{s.name}</div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {s.tabs.length} 标签 · {new Date(s.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="flex gap-1">
              <button onClick={() => handleRestore(s.id)} className="px-2 py-1 text-xs rounded hover:bg-[var(--color-bg-hover)]">恢复</button>
              <button onClick={() => handleDelete(s.id)} className="px-2 py-1 text-xs text-[var(--color-danger)] rounded hover:bg-[var(--color-bg-hover)]">删除</button>
            </div>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="text-center text-[var(--color-text-muted)] text-sm py-8">暂无保存的会话</div>
        )}
      </div>
    </div>
  )
}
