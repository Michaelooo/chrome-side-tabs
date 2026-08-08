import type { CleanupItem } from '../lib/tab-tools'

function getHostname(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function getDecisionLabel(decision: CleanupItem['decision']) {
  if (decision === 'close') return '建议关闭'
  if (decision === 'keep') return '建议保留'
  return '不确定'
}

export default function CleanupOverlay({ items, loading, error, onToggle, onClose, onConfirm, onStash }: {
  items: CleanupItem[]
  loading: boolean
  error: string | null
  onToggle: (tabId: number) => void
  onClose: () => void
  onConfirm: () => void
  onStash: () => void
}) {
  const selectedCount = items.filter(item => item.selected).length

  return (
    <div className="absolute inset-0 z-50 bg-black/50 flex items-start justify-center pt-6" onClick={onClose}>
      <div className="w-[calc(100%-12px)] max-h-[calc(100%-48px)] rounded-lg border shadow-2xl overflow-hidden flex flex-col" style={{ background: 'var(--t-bg-active)', borderColor: 'var(--t-border)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--t-border)' }}>
          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>智能清理</div>
            <div className="text-[10px]" style={{ color: 'var(--t-text-muted)' }}>确认后才会关闭标签</div>
          </div>
          <button className="p-1 rounded" style={{ color: 'var(--t-text-muted)' }} onClick={onClose}>×</button>
        </div>

        <div className="overflow-y-auto p-2 flex-1">
          {loading && <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>AI 正在判断候选标签...</div>}
          {!loading && error && <div className="mb-2 p-2 rounded text-xs bg-red-900/30 text-red-300">{error}</div>}
          {!loading && items.length === 0 && <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>没有发现需要清理的候选标签</div>}
          {!loading && items.map(item => (
            <label key={item.id} className="flex gap-2 p-2 rounded cursor-pointer" style={{ color: 'var(--t-text-secondary)' }}>
              <input type="checkbox" checked={item.selected} onChange={() => onToggle(item.id)} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: item.decision === 'close' ? 'rgba(239,68,68,0.16)' : 'var(--t-bg)', color: item.decision === 'close' ? '#ef4444' : 'var(--t-text-muted)' }}>{getDecisionLabel(item.decision)}</span>
                  <span className="text-[10px] truncate" style={{ color: 'var(--t-text-faint)' }}>{getHostname(item.url)}</span>
                </div>
                <div className="text-xs truncate" style={{ color: 'var(--t-text)' }}>{item.title}</div>
                <div className="text-[10px] truncate" style={{ color: 'var(--t-text-faint)' }}>{item.url}</div>
                <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--t-text-muted)' }}>
                  {item.aiReason}；候选原因：{item.reasons.join('、')}
                </div>
              </div>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--t-border)' }}>
          <span className="text-[10px]" style={{ color: 'var(--t-text-muted)' }}>已选 {selectedCount} 个</span>
          <div className="flex gap-1">
            <button className="px-2 py-1.5 rounded text-xs" style={{ color: 'var(--t-text-muted)' }} onClick={onClose}>取消</button>
            <button
              className="px-2 py-1.5 rounded text-xs disabled:opacity-40"
              style={{ color: '#ef4444' }}
              disabled={selectedCount === 0}
              onClick={onConfirm}
            >
              直接关闭
            </button>
            <button
              className="px-3 py-1.5 rounded text-xs disabled:opacity-40"
              style={{ background: '#6366f1', color: '#fff' }}
              disabled={selectedCount === 0}
              onClick={onStash}
              title="关掉但存进归档，随时能恢复"
            >
              归档并关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
