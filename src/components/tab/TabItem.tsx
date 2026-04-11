import { useState } from 'react'
import type { AppTab } from '../../types/entities'

interface Props {
  tab: AppTab
  onActivate: (tabId: number) => void
  onClose: (tabId: number) => void
  indent?: boolean
}

export function TabItem({ tab, onActivate, onClose, indent }: Props) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors ${
        tab.active
          ? 'bg-[var(--color-bg-active)]'
          : 'hover:bg-[var(--color-bg-hover)]'
      } ${tab.discarded ? 'opacity-50' : ''} ${indent ? 'ml-3' : ''}`}
      onClick={() => onActivate(tab.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Favicon */}
      <div className="w-4 h-4 shrink-0 flex items-center justify-center">
        {tab.favIconUrl ? (
          <img src={tab.favIconUrl} alt="" className="w-4 h-4" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        ) : (
          <div className="w-3 h-3 rounded-sm bg-[var(--color-border)]" />
        )}
      </div>

      {/* Title */}
      <div className="flex-1 min-w-0">
        <div className={`text-xs truncate ${tab.pinned ? 'font-medium' : ''}`}>
          {tab.pinned && <span className="mr-0.5 text-[var(--color-accent)]">📌</span>}
          {tab.title || tab.url}
        </div>
      </div>

      {/* Close button */}
      {(hovered || tab.active) && (
        <button
          onClick={e => { e.stopPropagation(); onClose(tab.id) }}
          className="p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors shrink-0"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )
}
