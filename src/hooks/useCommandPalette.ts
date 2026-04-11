import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'

export function useCommandPalette() {
  const { commandPaletteOpen, toggleCommandPalette, setCommandPaletteOpen } = useUIStore()

  useEffect(() => {
    function handleMessage(msg: unknown) {
      const m = msg as { type: string }
      if (m.type === 'toggleCommandPalette') {
        toggleCommandPalette()
      }
    }
    chrome.runtime?.onMessage?.addListener(handleMessage)
    return () => chrome.runtime?.onMessage?.removeListener(handleMessage)
  }, [toggleCommandPalette])

  // Keyboard shortcut inside sidepanel
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        toggleCommandPalette()
      }
      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [toggleCommandPalette, commandPaletteOpen, setCommandPaletteOpen])

  return { commandPaletteOpen, setCommandPaletteOpen, toggleCommandPalette }
}
