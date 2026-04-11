import { useState } from 'react'
import type { VirtualGroup, AppTab } from '../../types/entities'
import { TabItem } from './TabItem'
import { useTabsStore } from '../../stores/tabsStore'
import { sendMessage } from '../../lib/messaging'

const COLOR_MAP: Record<string, string> = {
  blue: 'var(--color-group-blue)',
  red: 'var(--color-group-red)',
  yellow: 'var(--color-group-yellow)',
  green: 'var(--color-group-green)',
  pink: 'var(--color-group-pink)',
  purple: 'var(--color-group-purple)',
  cyan: 'var(--color-group-cyan)',
  orange: 'var(--color-group-orange)',
}

interface Props {
  group: VirtualGroup
  onActivate: (tabId: number) => void
  onClose: (tabId: number) => void
}

export function TabGroupBlock({ group, onActivate, onClose }: Props) {
  const [collapsed, setCollapsed] = useState(group.collapsed)
  const tabs = useTabsStore(s => s.tabs.filter(t => group.tabIds.includes(t.id)))

  async function toggleCollapse() {
    setCollapsed(!collapsed)
    await sendMessage({ type: 'toggleGroupCollapse', groupId: group.id })
  }

  const color = COLOR_MAP[group.color] ?? COLOR_MAP.blue

  return (
    <div className="mt-1">
      <button
        onClick={toggleCollapse}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded text-xs font-medium hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-[var(--color-text-secondary)] truncate">{group.title}</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">{tabs.length}</span>
        <svg
          className={`ml-auto transition-transform ${collapsed ? '' : 'rotate-90'}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {!collapsed && tabs.map(tab => (
        <TabItem key={tab.id} tab={tab} onActivate={onActivate} onClose={onClose} indent />
      ))}
    </div>
  )
}
