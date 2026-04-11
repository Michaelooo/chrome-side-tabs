import { useState } from 'react'
import { useAIGrouping } from '../../hooks/useAIGrouping'
import { useTabsStore } from '../../stores/tabsStore'

export function TabListHeader() {
  const [showMenu, setShowMenu] = useState(false)
  const { regroup } = useAIGrouping()
  const tabs = useTabsStore(s => s.tabs)

  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-border)]">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <span className="text-sm font-semibold">Tabs</span>
        <span className="text-xs text-[var(--color-text-muted)]">{tabs.length}</span>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => regroup(true)}
          className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
          title="AI 分组"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </button>

        <button
          onClick={() => setShowMenu(false)}
          className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
          title="更多"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
          </svg>
        </button>
      </div>
    </div>
  )
}
