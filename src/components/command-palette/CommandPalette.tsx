import { useState, useEffect, useRef } from 'react'
import Fuse from 'fuse.js'
import { useUIStore } from '../../stores/uiStore'
import { useTabsStore } from '../../stores/tabsStore'
import { sendMessage } from '../../lib/messaging'

export function CommandPalette() {
  const open = useUIStore(s => s.commandPaletteOpen)
  const setOpen = useUIStore(s => s.setCommandPaletteOpen)
  const tabs = useTabsStore(s => s.tabs)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const fuse = new Fuse(tabs, {
    keys: ['title', 'url'],
    threshold: 0.4,
  })

  const results = query ? fuse.search(query).map(r => r.item) : tabs

  useEffect(() => {
    if (open) {
      setQuery('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-50 bg-black/60 flex items-start justify-center pt-8">
      <div className="w-[calc(100%-16px)] bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索标签..."
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--color-text-muted)]"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)] text-[var(--color-text-muted)]">ESC</kbd>
        </div>

        <div className="max-h-64 overflow-y-auto">
          {results.slice(0, 20).map(tab => (
            <button
              key={tab.id}
              className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-[var(--color-bg-hover)] transition-colors"
              onClick={() => {
                sendMessage({ type: 'activate', tabId: tab.id })
                setOpen(false)
              }}
            >
              {tab.favIconUrl ? (
                <img src={tab.favIconUrl} alt="" className="w-4 h-4 shrink-0" />
              ) : (
                <div className="w-4 h-4 shrink-0 rounded-sm bg-[var(--color-border)]" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{tab.title || tab.url}</div>
                <div className="text-[10px] text-[var(--color-text-muted)] truncate">{tab.url}</div>
              </div>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-[var(--color-text-muted)]">无匹配结果</div>
          )}
        </div>
      </div>
    </div>
  )
}
