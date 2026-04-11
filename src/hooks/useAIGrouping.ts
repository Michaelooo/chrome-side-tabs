import { useCallback } from 'react'
import { useUIStore } from '../stores/uiStore'
import { sendMessage } from '../lib/messaging'

export function useAIGrouping() {
  const { currentWindowId } = useUIStore()

  const regroup = useCallback(async (force = false) => {
    if (!currentWindowId) return
    await sendMessage({ type: 'regroup', windowId: currentWindowId, force })
  }, [currentWindowId])

  return { regroup }
}
