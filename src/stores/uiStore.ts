import { create } from 'zustand'

interface UIState {
  commandPaletteOpen: boolean
  currentWindowId: number | null
  searchQuery: string
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void
  setCurrentWindowId: (id: number) => void
  setSearchQuery: (query: string) => void
}

export const useUIStore = create<UIState>((set, get) => ({
  commandPaletteOpen: false,
  currentWindowId: null,
  searchQuery: '',
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  toggleCommandPalette: () => set({ commandPaletteOpen: !get().commandPaletteOpen }),
  setCurrentWindowId: (id) => set({ currentWindowId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}))
