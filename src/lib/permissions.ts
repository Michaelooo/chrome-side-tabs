import type { AssistantAction, AssistantLookup } from './assistant'

/**
 * 这三个权限声明在 manifest 的 optional_permissions 里，安装时不会提示，
 * 只有用户真正用到对应功能时才申请。授权一次后永久有效，
 * 用户也可以随时在 chrome://extensions 里单独收回。
 */
export type OptionalPermission = 'history' | 'bookmarks' | 'sessions'

export const PERMISSION_LABEL: Record<OptionalPermission, string> = {
  history: '浏览历史',
  bookmarks: '书签',
  sessions: '最近关闭的标签',
}

export const PERMISSION_REASON: Record<OptionalPermission, string> = {
  history: '用来在你的浏览历史里检索，只在你提问时查询，不会上传',
  bookmarks: '用来检索书签，以及把标签导出成书签文件夹',
  sessions: '用来查看和恢复最近关闭的标签页',
}

export async function hasPermissions(permissions: OptionalPermission[]): Promise<boolean> {
  if (permissions.length === 0) return true
  return chrome.permissions.contains({ permissions })
}

export async function missingPermissions(permissions: OptionalPermission[]): Promise<OptionalPermission[]> {
  const missing: OptionalPermission[] = []
  for (const p of permissions) {
    if (!(await chrome.permissions.contains({ permissions: [p] }))) missing.push(p)
  }
  return missing
}

/** 必须在用户手势里调用，否则 Chrome 会直接拒绝 */
export async function requestPermissions(permissions: OptionalPermission[]): Promise<boolean> {
  if (permissions.length === 0) return true
  return chrome.permissions.request({ permissions })
}

export function permissionsForAction(action: AssistantAction): OptionalPermission[] {
  if (action.action === 'exportBookmarks') return ['bookmarks']
  if (action.action === 'restoreClosed') return ['sessions']
  return []
}

export function permissionsForLookup(lookup: AssistantLookup): OptionalPermission[] {
  const out: OptionalPermission[] = []
  if (lookup.history) out.push('history')
  if (lookup.bookmarks) out.push('bookmarks')
  if (lookup.recentlyClosed) out.push('sessions')
  return out
}
