import { useState, useEffect } from 'react'
import { sendMessage } from '../../lib/messaging'
import type { Session } from '../../types/entities'

interface Props {
  open: boolean
  onClose: () => void
}

export function SessionDialog({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) loadSessions()
  }, [open])

  async function loadSessions() {
    const res = await sendMessage({ type: 'getSessions' })
    if (res.success && res.data) setSessions(res.data as Session[])
  }

  async function handleSave() {
    if (!name.trim()) return
    const win = await chrome.windows.getCurrent()
    await sendMessage({ type: 'saveSession', name: name.trim(), windowId: win.id! })
    setName('')
    await loadSessions()
  }

  async function handleRestore(id: string) {
    await sendMessage({ type: 'restoreSession', sessionId: id })
    onClose()
  }

  async function handleDelete(id: string) {
    await sendMessage({ type: 'deleteSession', sessionId: id })
    await loadSessions()
  }

  if (!open) return null

  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-semibold">会话管理</h3>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="会话名称"
              className="flex-1 px-2 py-1.5 rounded bg-[var(--color-bg-primary)] text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
              onKeyDown={e => e.key === 'Enter' && handleSave()}
            />
            <button onClick={handleSave} disabled={!name.trim()} className="px-3 py-1.5 rounded bg-[var(--color-accent)] text-white text-sm disabled:opacity-50">保存</button>
          </div>

          <div className="max-h-48 overflow-y-auto space-y-2">
            {sessions.map(s => (
              <div key={s.id} className="flex items-center justify-between p-2 rounded bg-[var(--color-bg-primary)]">
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{s.name}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">{s.tabs.length} 标签</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => handleRestore(s.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--color-bg-hover)]">恢复</button>
                  <button onClick={() => handleDelete(s.id)} className="text-[10px] px-1.5 py-0.5 rounded text-[var(--color-danger)] hover:bg-[var(--color-bg-hover)]">删</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
