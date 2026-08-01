import { create } from 'zustand'
import type { AppConfig } from '../types/entities'

interface ConfigState {
  config: AppConfig | null
  setConfig: (config: AppConfig) => void
  updateConfig: (partial: Partial<AppConfig>) => void
}

const DEFAULT_CONFIG: AppConfig = {
  ai: { baseURL: '', apiKey: '', model: 'deepseek-chat', enabled: false, customPrompt: '' },
  grouping: { autoThreshold: 10, throttleMs: 30000, rules: [] },
  suspend: { enabled: false, idleMinutes: 30, whitelist: [] },
  stash: { autoEnabled: false, autoDays: 7 },
  ui: { theme: 'dark', density: 'comfortable' },
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  setConfig: (config) => set({ config }),
  updateConfig: (partial) => {
    const current = get().config ?? DEFAULT_CONFIG
    set({ config: { ...current, ...partial } })
  },
}))
