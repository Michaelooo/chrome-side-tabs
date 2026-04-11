export type MessageRequest =
  | { type: 'activate'; tabId: number }
  | { type: 'close'; tabId: number }
  | { type: 'closeOthers'; tabId: number }
  | { type: 'pin'; tabId: number }
  | { type: 'discard'; tabId: number }
  | { type: 'regroup'; windowId: number; force?: boolean }
  | { type: 'saveSession'; name: string; windowId: number }
  | { type: 'restoreSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'getSessions' }
  | { type: 'getDuplicates'; windowId: number }
  | { type: 'closeDuplicates'; urls: string[]; keepTabId: number }
  | { type: 'toggleCommandPalette' }
  | { type: 'moveTab'; tabId: number; fromGroup: string | null; toGroup: string | null; newIndex: number }
  | { type: 'createGroup'; title: string; tabIds: number[] }
  | { type: 'renameGroup'; groupId: string; title: string }
  | { type: 'deleteGroup'; groupId: string }
  | { type: 'toggleGroupCollapse'; groupId: string }
  | { type: 'getTabs'; windowId: number }
  | { type: 'getGroups'; windowId: number }

export type MessageResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string }
