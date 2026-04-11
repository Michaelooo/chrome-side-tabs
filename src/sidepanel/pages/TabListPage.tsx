import { TabListHeader } from '../../components/tab/TabListHeader'
import { TabGroupBlock } from '../../components/tab/TabGroupBlock'
import { TabItem } from '../../components/tab/TabItem'
import { FirstRunBanner } from '../../components/onboarding/FirstRunBanner'
import { useTabsStore } from '../../stores/tabsStore'
import { useTabs } from '../../hooks/useTabs'

export function TabListPage() {
  const { tabs, groups } = useTabsStore()
  const { activateTab, closeTab } = useTabs()
  const ungroupedTabs = useTabsStore(s => s.getUngroupedTabs())

  return (
    <div className="flex flex-col h-full">
      <TabListHeader />
      <FirstRunBanner />

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {/* Grouped tabs */}
        {groups.map(group => (
          <TabGroupBlock key={group.id} group={group} onActivate={activateTab} onClose={closeTab} />
        ))}

        {/* Ungrouped tabs */}
        {ungroupedTabs.length > 0 && groups.length > 0 && (
          <div className="mt-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <span>未分组</span>
              <span className="text-[10px] opacity-60">{ungroupedTabs.length}</span>
            </div>
            {ungroupedTabs.map(tab => (
              <TabItem key={tab.id} tab={tab} onActivate={activateTab} onClose={closeTab} />
            ))}
          </div>
        )}

        {/* No groups - show all tabs flat */}
        {groups.length === 0 && tabs.map(tab => (
          <TabItem key={tab.id} tab={tab} onActivate={activateTab} onClose={closeTab} />
        ))}

        {/* Empty state */}
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-32 text-[var(--color-text-muted)] text-sm">
            没有打开的标签
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--color-border)] px-2 py-1.5">
        <button
          onClick={() => chrome.tabs.create({ url: 'chrome://newtab' })}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <span className="text-base leading-none">+</span>
          <span>新标签</span>
        </button>
      </div>
    </div>
  )
}
