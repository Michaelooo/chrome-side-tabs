import type { AppConfig, Session, VirtualGroup, StashedTab } from '../types/entities'

export interface BackupFile {
  format: 'side-tabs-backup'
  version: 1
  exportedAt: number
  config?: AppConfig
  sessions?: Session[]
  stash?: StashedTab[]
  groups?: Record<number, VirtualGroup[]>
  theme?: 'dark' | 'light'
}

// ai_cache 不备份：它是可以重新算出来的，而且体积最大
const BACKUP_KEYS = ['config', 'sessions', 'stash', 'groups', 'theme'] as const

export async function exportBackup(includeApiKey: boolean): Promise<BackupFile> {
  const raw = await chrome.storage.local.get([...BACKUP_KEYS])
  const config = raw.config as AppConfig | undefined

  return {
    format: 'side-tabs-backup',
    version: 1,
    exportedAt: Date.now(),
    config: config
      ? { ...config, ai: { ...config.ai, apiKey: includeApiKey ? config.ai.apiKey : '' } }
      : undefined,
    sessions: raw.sessions as Session[] | undefined,
    stash: raw.stash as StashedTab[] | undefined,
    groups: raw.groups as Record<number, VirtualGroup[]> | undefined,
    theme: raw.theme as 'dark' | 'light' | undefined,
  }
}

export function downloadBackup(backup: BackupFile) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10)
  a.href = url
  a.download = `sift-backup-${stamp}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export interface ImportResult {
  restored: string[]
  skipped: string[]
}

/**
 * 导入采用合并策略而不是覆盖：归档和会话按 id 去重后追加，
 * 免得一次误操作把现有数据冲没了。
 */
export async function importBackup(file: BackupFile): Promise<ImportResult> {
  if (file?.format !== 'side-tabs-backup') {
    throw new Error('这不是 Sift 的备份文件')
  }

  const current = await chrome.storage.local.get([...BACKUP_KEYS])
  const patch: Record<string, unknown> = {}
  const restored: string[] = []
  const skipped: string[] = []

  if (file.config) {
    const cur = current.config as AppConfig | undefined
    // 备份里没带 API Key 时，保留本机现有的，不要把它清空
    const apiKey = file.config.ai.apiKey || cur?.ai.apiKey || ''
    patch.config = { ...file.config, ai: { ...file.config.ai, apiKey } }
    restored.push('设置')
  } else {
    skipped.push('设置')
  }

  if (file.stash?.length) {
    const cur = (current.stash as StashedTab[] | undefined) ?? []
    const seen = new Set(cur.map(s => s.url))
    const merged = [...cur, ...file.stash.filter(s => !seen.has(s.url))]
    patch.stash = merged
    restored.push(`归档 ${merged.length - cur.length} 条`)
  }

  if (file.sessions?.length) {
    const cur = (current.sessions as Session[] | undefined) ?? []
    const seen = new Set(cur.map(s => s.id))
    const merged = [...cur, ...file.sessions.filter(s => !seen.has(s.id))]
    patch.sessions = merged
    restored.push(`会话 ${merged.length - cur.length} 个`)
  }

  // 分组是按 windowId 存的，换台机器/重开浏览器后 windowId 对不上，
  // 恢复了也认不回来，所以不导入。
  if (file.groups) skipped.push('分组（窗口 ID 已失效）')

  if (file.theme) {
    patch.theme = file.theme
    restored.push('主题')
  }

  await chrome.storage.local.set(patch)
  return { restored, skipped }
}
