import { useState } from 'react'

export function FirstRunBanner() {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem('sbt_onboarding_dismissed') === 'true'
  })

  if (dismissed) return null

  return (
    <div className="mx-2 mt-2 p-3 rounded-lg bg-[var(--color-bg-active)] border border-[var(--color-accent)]/30 text-xs text-[var(--color-text-secondary)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-[var(--color-text-primary)] mb-1">提示：将侧边栏设为左侧</p>
          <p>前往 chrome://settings/appearance，找到"侧边栏"选项，选择"在左侧显示"。</p>
        </div>
        <button
          onClick={() => { setDismissed(true); localStorage.setItem('sbt_onboarding_dismissed', 'true') }}
          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
    </div>
  )
}
