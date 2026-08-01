import type { AssistantAction } from './assistant'

// 助手对话的轻量持久化。
// 截图（dataURL）不入库：一张整页截图就有几 MB，
// chrome.storage.local 只有 10MB 配额，存几张就满了。

export interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  notes?: string[]
  error?: boolean
  actions?: AssistantAction[]
  done?: boolean
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: StoredChatMessage[]
}

const KEY = 'chat_sessions'

// 自动清理的三重上限，超出即静默裁掉
export const MAX_SESSIONS = 20
export const MAX_MESSAGES_PER_SESSION = 60
export const MAX_AGE_DAYS = 30
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 3600 * 1000

async function readAll(): Promise<ChatSession[]> {
  const result = await chrome.storage.local.get(KEY)
  return (result[KEY] as ChatSession[]) ?? []
}

async function writeAll(list: ChatSession[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: list })
}

function prune(list: ChatSession[]): ChatSession[] {
  const now = Date.now()
  return list
    .filter(s => s.messages.length > 0 && now - s.updatedAt < MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)
}

export const chatStore = {
  async list(): Promise<ChatSession[]> {
    const pruned = prune(await readAll())
    return pruned
  },

  async save(session: ChatSession): Promise<void> {
    if (session.messages.length === 0) return
    const trimmed: ChatSession = {
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
    }
    const rest = (await readAll()).filter(s => s.id !== session.id)
    await writeAll(prune([trimmed, ...rest]))
  },

  async remove(id: string): Promise<void> {
    await writeAll((await readAll()).filter(s => s.id !== id))
  },

  async clear(): Promise<void> {
    await writeAll([])
  },
}

export function makeChatId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function chatTitleFrom(messages: Array<{ role: string; text: string }>): string {
  const first = messages.find(m => m.role === 'user')
  const t = (first?.text ?? '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 30) : '未命名对话'
}
