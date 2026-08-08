import { useState, useEffect, useRef, useCallback } from 'react'
import type { AppTab, VirtualGroup, GroupColor } from '../types/entities'
import type { TabOrigin } from '../lib/provenance'
import { askAssistant, ACTION_LABEL, DESTRUCTIVE_ACTIONS, isAutoRunnable, actionWarning } from '../lib/assistant'
import type { AssistantAction, ChatTurn } from '../lib/assistant'
import { executeActions } from '../lib/tab-actions'
import { queryAllTabs } from '../lib/tab-manager'
import type { Shot } from '../lib/tab-actions'
import {
  missingPermissions, requestPermissions, permissionsForAction,
  PERMISSION_LABEL, PERMISSION_REASON,
} from '../lib/permissions'
import type { OptionalPermission } from '../lib/permissions'
import { storage } from '../lib/storage'
import { chatStore, makeChatId, chatTitleFrom, MAX_SESSIONS, MAX_AGE_DAYS } from '../lib/chat-store'
import type { ChatSession, StoredChatMessage } from '../lib/chat-store'
import { formatStashedAt } from '../lib/stash'
import Markdown from './Markdown'

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  actions?: AssistantAction[]
  shots?: Shot[]
  notes?: string[]
  /** 已确认执行过，不再显示确认按钮 */
  done?: boolean
  error?: boolean
  /** 缺这些权限才能继续，UI 上摆一个授权按钮 */
  needsPermissions?: OptionalPermission[]
  /** 授权后要重发的问题 */
  retryQuestion?: string
}

const SUGGESTIONS = [
  '哪些标签在摸鱼？',
  '哪些标签最吃内存？',
  '总结一下我正在看的页面',
  '恢复我刚关掉的页面',
  '把这些标签按项目分组',
  '把这个页面截个整页长图',
]

function actionSummary(action: AssistantAction): string {
  const label = ACTION_LABEL[action.action]
  if (action.action === 'group') return `${label}「${action.title}」`
  if (action.action === 'screenshot') return `${label}（${action.fullPage ? '整页' : '可见区域'}）`
  if (action.action === 'pin') return action.pinned ? '固定' : '取消固定'
  if (action.action === 'mute') return action.muted ? '静音' : '取消静音'
  if (action.action === 'exportBookmarks') return `${label}「${action.folderName}」`
  return label
}

function shotFilename(shot: Shot): string {
  return `${shot.title.slice(0, 30).replace(/[/\\?%*:|"<>]/g, '-')}.png`
}

/**
 * 持久化裁剪：截图太大不入库；没执行的操作按钮恢复后 tabId 早就失效了，
 * 存下来也只能误导，直接转成一条说明。
 */
function toStored(m: Message): StoredChatMessage {
  const notes = [...(m.notes ?? [])]
  if (m.shots?.length) notes.push(`此条曾包含 ${m.shots.length} 张截图（截图不保存到历史）`)
  if (m.actions && !m.done) notes.push('此条的操作未执行，恢复历史后已失效')
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    notes: notes.length ? notes : undefined,
    error: m.error,
    actions: m.done ? m.actions : undefined,
    done: m.done,
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* 剪贴板不可用时静默 */ }
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity px-1 py-0.5 rounded flex items-center gap-1 shrink-0 text-[9px]"
      style={{ color: copied ? '#22c55e' : 'var(--t-text-faint)' }}
      title="复制这条消息"
    >
      {copied ? (
        <>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          已复制
        </>
      ) : (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  )
}

export default function Assistant({ tabs: windowTabs, groups, origins, onSelect, onGroup, onChanged, onOpenChange, embedded = false, seedQuestion }: {
  tabs: AppTab[]
  groups: VirtualGroup[]
  origins: Record<number, TabOrigin>
  onSelect: (tabIds: number[]) => void
  onGroup: (title: string, color: GroupColor, tabIds: number[]) => Promise<void>
  onChanged: () => void
  /** 面板开关同步给宿主，让侧栏的 j/k/x 键盘导航在面板打开时让位 */
  onOpenChange?: (open: boolean) => void
  /**
   * 内嵌模式：不画自己的浮球，也不铺遮罩，直接作为宿主布局里的一块常驻区域。
   * 浮球面板用这个——页面上已经有一个浮球了，不该再套一个。
   */
  embedded?: boolean
  /** 挂载后自动发出的第一个问题。性能页的「让 AI 分析」用它把话题直接带过来 */
  seedQuestion?: string
}) {
  const [open, setOpen] = useState(embedded)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [preview, setPreview] = useState<Shot | null>(null)
  const [chatId, setChatId] = useState(() => makeChatId())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyList, setHistoryList] = useState<ChatSession[]>([])
  const [confirmClear, setConfirmClear] = useState(false)
  const createdAtRef = useRef(Date.now())
  const seedSent = useRef(false)
  // 侧栏列表只显示当前窗口，但助手必须看到所有窗口的标签，
  // 否则用户在别的窗口开的页面会被当成"不存在"。
  const [tabs, setTabs] = useState<AppTab[]>(windowTabs)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const syncTabs = useCallback(async () => {
    try {
      setTabs(await queryAllTabs())
    } catch {
      setTabs(windowTabs)
    }
  }, [windowTabs])

  useEffect(() => { syncTabs() }, [syncTabs])

  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])

  // 预览打开时焦点可能不在输入框上，ESC 要全局兜住
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const persist = useCallback(async (msgs: Message[]) => {
    if (msgs.length === 0) return
    await chatStore.save({
      id: chatId,
      title: chatTitleFrom(msgs),
      createdAt: createdAtRef.current,
      updatedAt: Date.now(),
      messages: msgs.map(toStored),
    })
  }, [chatId])

  // 每次消息变化后防抖落盘，面板关掉、浏览器重启都不丢
  useEffect(() => {
    if (messages.length === 0) return
    const t = setTimeout(() => { persist(messages) }, 400)
    return () => clearTimeout(t)
  }, [messages, persist])

  async function newChat() {
    await persist(messages)
    setMessages([])
    setChatId(makeChatId())
    createdAtRef.current = Date.now()
    setHistoryOpen(false)
    inputRef.current?.focus()
  }

  async function openHistory() {
    await persist(messages)
    setHistoryList(await chatStore.list())
    setConfirmClear(false)
    setHistoryOpen(true)
  }

  function loadChat(session: ChatSession) {
    setMessages(session.messages.map(m => ({ ...m })))
    setChatId(session.id)
    createdAtRef.current = session.createdAt
    setHistoryOpen(false)
  }

  async function removeChat(id: string) {
    await chatStore.remove(id)
    setHistoryList(await chatStore.list())
  }

  async function clearAllChats() {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    await chatStore.clear()
    setHistoryList([])
    setConfirmClear(false)
  }

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      syncTabs()
    }
  }, [open, syncTabs])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async (text: string) => {
    const question = text.trim()
    if (!question || busy) return

    setInput('')
    setBusy(true)
    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', text: question }
    setMessages(prev => [...prev, userMsg])

    try {
      const config = await storage.config.get()
      if (!config.ai.apiKey || !config.ai.baseURL) {
        chrome.runtime.openOptionsPage()
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`, role: 'assistant', error: true,
          text: '还没配置 AI，已经帮你打开设置页了。',
        }])
        return
      }

      // 提问前重新抓一次，避免拿着过期的标签列表去问
      const liveTabs = await queryAllTabs().catch(() => tabs)
      setTabs(liveTabs)

      const history: ChatTurn[] = messages.map(m => ({ role: m.role, content: m.text }))
      const { data, error, missingPermissions: missing } = await askAssistant(
        question, liveTabs, groups, origins, history, config, setProgress,
      )
      setProgress(null)

      if (!data) {
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`, role: 'assistant', error: true, text: error || '未知错误',
        }])
        return
      }

      // 要查历史/书签但还没授权：摆个按钮，用户点了才弹 Chrome 的确认框
      if (missing && missing.length > 0) {
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: `这个问题需要查${missing.map(p => PERMISSION_LABEL[p]).join('和')}才能回答。`,
          needsPermissions: missing,
          retryQuestion: question,
        }])
        return
      }

      // 无副作用的操作直接执行，不打扰用户；其余等确认
      const auto = data.actions.filter(isAutoRunnable)
      const needsConfirm = data.actions.filter(a => !isAutoRunnable(a))

      const selected = auto.filter(a => a.action === 'select').flatMap(a => a.tabIds)
      if (selected.length > 0) onSelect(selected)

      let shots: Shot[] = []
      const notes: string[] = []
      const runnable = auto.filter(a => a.action !== 'select')
      if (runnable.length > 0) {
        const result = await executeActions(runnable, liveTabs, onGroup, setProgress)
        shots = result.shots
        notes.push(...result.notes)
        setProgress(null)
        onChanged()
        syncTabs()
      }

      // 模型有时会在回答里说"我这就去做"，却没给出对应的操作。
      // 以前这种情况完全静默，看起来就像卡死了。
      if (data.dropped.length > 0) {
        notes.push(...data.dropped.map(d => `没能执行 — ${d}`))
      } else if (data.actions.length === 0 && /我(现在|这就|来|帮你)?(就)?(去|给|帮)/.test(data.answer)) {
        notes.push('它说要动手，但没有给出可执行的操作，所以什么都没发生。可以再说一次，或者说得更具体点。')
      }

      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: data.answer,
        actions: needsConfirm.length > 0 ? needsConfirm : undefined,
        shots: shots.length > 0 ? shots : undefined,
        notes: notes.length > 0 ? notes : undefined,
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`, role: 'assistant', error: true, text: String(err),
      }])
    } finally {
      setBusy(false)
    }
  }, [busy, messages, tabs, groups, origins, onSelect, onGroup, onChanged, syncTabs])

  // 带过来的问题只发一次。StrictMode 下 effect 会跑两遍，用 ref 挡住
  useEffect(() => {
    if (!seedQuestion || seedSent.current) return
    seedSent.current = true
    send(seedQuestion)
  }, [seedQuestion, send])

  /** 必须由按钮点击直接触发，Chrome 要求 request 在用户手势里调用 */
  async function grantAndRetry(msg: Message) {
    if (!msg.needsPermissions) return
    const granted = await requestPermissions(msg.needsPermissions)
    setMessages(prev => prev.map(m => m.id === msg.id
      ? { ...m, needsPermissions: undefined, text: granted ? '已授权，重新查一下。' : '没有授权，这个问题我查不了。' }
      : m))
    if (granted && msg.retryQuestion) send(msg.retryQuestion)
  }

  async function confirm(msgId: string, actions: AssistantAction[]) {
    // 分屏要屏幕信息、导书签要书签权限，缺了先申请（这里也在点击手势里）
    const needed = [...new Set(actions.flatMap(permissionsForAction))]
    const missing = await missingPermissions(needed)
    if (missing.length > 0) {
      const granted = await requestPermissions(missing)
      if (!granted) {
        setMessages(prev => prev.map(m => m.id === msgId
          ? { ...m, done: true, notes: [`没有授权${missing.map(p => PERMISSION_LABEL[p]).join('和')}，操作已取消`] }
          : m))
        return
      }
    }

    setBusy(true)
    try {
      const result = await executeActions(actions, tabs, onGroup, setProgress)
      syncTabs()
      setMessages(prev => prev.map(m => m.id === msgId
        ? {
            ...m,
            done: true,
            shots: result.shots.length ? result.shots : m.shots,
            notes: result.notes.length ? result.notes : ['已完成'],
          }
        : m))
      onChanged()
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === msgId
        ? { ...m, done: true, notes: [`执行失败：${String(err)}`] }
        : m))
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  if (!embedded && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="orb-idle absolute bottom-14 right-3 z-40 w-11 h-11 rounded-full flex items-center justify-center"
        style={{
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 55%, #06b6d4 100%)',
          border: '1px solid rgba(255,255,255,0.18)',
        }}
        title="问问标签助手"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 3l.8 4.7 4.7.8-4.7.8-.8 4.7-.8-4.7L4 8.5l4.7-.8z" />
          <path d="M17.5 13l.5 2.5 2.5.5-2.5.5-.5 2.5-.5-2.5-2.5-.5 2.5-.5z" />
        </svg>
      </button>
    )
  }

  const panel = (
    <div
      className={embedded
        ? 'relative flex flex-col flex-1 min-h-0'
        : 'panel-in relative m-1.5 rounded-xl overflow-hidden flex flex-col flex-1 min-h-0'}
      style={embedded
        ? { background: 'var(--t-bg)' }
        : {
            background: 'var(--t-bg-active)',
            border: '1px solid rgba(99,102,241,0.35)',
            boxShadow: '0 0 24px rgba(99,102,241,0.18), 0 8px 32px rgba(0,0,0,0.45)',
          }}
      onClick={e => e.stopPropagation()}
    >
        {/* 顶部：渐变细线 + 标题 */}
        {!embedded && <div style={{ height: 2, background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #06b6d4)' }} />}
        <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--t-border)' }}>
          <div className="flex items-center gap-2">
            <div
              className={busy ? 'orb-busy' : ''}
              style={{
                width: 16, height: 16, borderRadius: 8,
                background: 'linear-gradient(135deg, #6366f1, #06b6d4)',
              }}
            />
            <span className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>标签助手</span>
            <span className="text-[10px]" style={{ color: 'var(--t-text-faint)' }}>{tabs.length} 个标签在上下文里</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={openHistory}
              className="p-1 rounded"
              style={{ color: 'var(--t-text-muted)' }}
              title="历史对话"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
              </svg>
            </button>
            {messages.length > 0 && (
              <button
                onClick={newChat}
                className="p-1 rounded"
                style={{ color: 'var(--t-text-muted)' }}
                title="新对话（当前对话已自动存入历史）"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            )}
            {!embedded && (
              <button className="p-1 rounded" style={{ color: 'var(--t-text-muted)' }} onClick={() => setOpen(false)}>×</button>
            )}
          </div>
        </div>

        {/* 对话区 */}
        <div className="overflow-y-auto flex-1 min-h-0 px-3 py-2 select-text cursor-auto">
          {messages.length === 0 && (
            <div className="py-3">
              <div className="text-[11px] mb-2" style={{ color: 'var(--t-text-muted)' }}>
                我能看到你所有标签的标题、域名、闲置时长、分组和来源。问我，或者直接下命令。
              </div>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="w-full text-left px-2 py-1.5 rounded text-[11px] mb-0.5"
                  style={{ color: 'var(--t-text-secondary)', background: 'var(--t-bg)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {messages.map(m => (
            <div key={m.id} className="msg-in mb-3">
              {m.role === 'user' ? (
                <div className="group flex justify-end items-center gap-1">
                  <CopyButton text={m.text} />
                  <div
                    className="max-w-[85%] px-2.5 py-1.5 rounded-lg text-[11px]"
                    style={{ background: 'rgba(99,102,241,0.18)', color: 'var(--t-text)' }}
                  >
                    {m.text}
                  </div>
                </div>
              ) : (
                <div className="group">
                  <Markdown text={m.text} color={m.error ? '#ef4444' : 'var(--t-text)'} />
                  <div className="flex mt-0.5">
                    <CopyButton text={m.text} />
                  </div>

                  {m.notes?.map((note, i) => (
                    <div key={i} className="mt-1 text-[10px]" style={{ color: 'var(--t-text-faint)' }}>{note}</div>
                  ))}

                  {/* 可选权限：装扩展时不要，用到了才问，同意一次永久有效 */}
                  {m.needsPermissions && (
                    <div className="mt-2 rounded p-2" style={{ border: '1px solid rgba(99,102,241,0.35)', background: 'rgba(99,102,241,0.08)' }}>
                      {m.needsPermissions.map(p => (
                        <div key={p} className="mb-1.5">
                          <div className="text-[10px] font-medium" style={{ color: 'var(--t-text)' }}>
                            {PERMISSION_LABEL[p]}
                          </div>
                          <div className="text-[10px] leading-relaxed" style={{ color: 'var(--t-text-faint)' }}>
                            {PERMISSION_REASON[p]}
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center justify-between gap-2 mt-2">
                        <span className="text-[9px]" style={{ color: 'var(--t-text-faint)' }}>
                          只需授权一次，可随时在扩展页收回
                        </span>
                        <button
                          className="px-3 py-1 rounded text-[10px] font-medium shrink-0"
                          style={{ background: '#6366f1', color: '#fff' }}
                          onClick={() => grantAndRetry(m)}
                        >
                          授权
                        </button>
                      </div>
                    </div>
                  )}

                  {m.shots && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.shots.map(shot => (
                        <button
                          key={shot.tabId}
                          onClick={() => setPreview(shot)}
                          className="block rounded overflow-hidden cursor-zoom-in p-0"
                          style={{ border: '1px solid var(--t-border)', width: 92 }}
                          title={`${shot.title}（点击放大预览）`}
                        >
                          <img src={shot.dataUrl} alt="" style={{ width: '100%', display: 'block' }} />
                        </button>
                      ))}
                    </div>
                  )}

                  {m.actions && (
                    <div className="mt-2 rounded" style={{ border: '1px solid var(--t-border)' }}>
                      {m.actions.map((action, i) => {
                        const warning = actionWarning(action)
                        return (
                          <div
                            key={i}
                            className="px-2 py-1.5"
                            style={{ borderBottom: i < m.actions!.length - 1 ? '1px solid var(--t-border)' : undefined }}
                          >
                            <div
                              className="text-[10px] flex items-center gap-1.5"
                              style={{ color: DESTRUCTIVE_ACTIONS.has(action.action) ? '#ef4444' : 'var(--t-text-secondary)' }}
                            >
                              <span className="font-medium">{actionSummary(action)}</span>
                              <span style={{ color: 'var(--t-text-faint)' }}>
                                {'tabIds' in action
                                  ? `${action.tabIds.length} 个标签`
                                  : 'sessionIds' in action
                                    ? `${action.sessionIds.length} 个页面`
                                    : 'urls' in action ? `${action.urls.length} 个地址` : ''}
                              </span>
                            </div>
                            {/* 有副作用的操作把风险摊开说，但不拦着不让做 */}
                            {warning && (
                              <div className="mt-1 text-[9px] leading-relaxed" style={{ color: '#d08a4a' }}>
                                {warning}
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {!m.done && (
                        <div className="flex items-center justify-between gap-2 px-2 py-1.5" style={{ borderTop: '1px solid var(--t-border)' }}>
                          <button
                            className="px-2 py-1 rounded text-[10px]"
                            style={{ color: 'var(--t-text-muted)' }}
                            onClick={() => setMessages(prev => prev.map(x => x.id === m.id ? { ...x, actions: undefined } : x))}
                          >
                            算了
                          </button>
                          <button
                            className="px-3 py-1 rounded text-[10px] font-medium disabled:opacity-40"
                            style={{
                              background: m.actions.some(a => DESTRUCTIVE_ACTIONS.has(a.action)) ? '#ef4444' : '#6366f1',
                              color: '#fff',
                            }}
                            disabled={busy}
                            onClick={() => confirm(m.id, m.actions!)}
                          >
                            执行
                          </button>
                        </div>
                      )}
                      {m.done && (
                        <div className="px-2 py-1.5 text-[10px]" style={{ borderTop: '1px solid var(--t-border)', color: '#22c55e' }}>
                          已执行
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 py-1">
              <div className="orb-busy" style={{ width: 8, height: 8, borderRadius: 4, background: '#6366f1' }} />
              <span className="text-[10px]" style={{ color: 'var(--t-text-muted)' }}>
                {progress ?? '思考中...'}
              </span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="px-2 py-2" style={{ borderTop: '1px solid var(--t-border)' }}>
          <div
            className="flex items-end gap-1.5 px-2 py-1.5 rounded-lg"
            style={{ background: 'var(--t-bg)', border: '1px solid var(--t-border)' }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
                if (e.key === 'Escape') {
                  // 内嵌时 ESC 归宿主处理（浮球面板要整个收起），这里只管预览
                  if (preview) setPreview(null)
                  else if (!embedded) setOpen(false)
                }
              }}
              rows={1}
              placeholder="问点什么，或者直接下命令..."
              className="flex-1 bg-transparent text-[11px] resize-none focus:outline-none leading-relaxed"
              style={{ color: 'var(--t-text)', maxHeight: 72 }}
            />
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || busy}
              className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center disabled:opacity-30"
              style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>

        {/* 历史对话 */}
        {historyOpen && (
          <div className="absolute inset-0 z-[55] flex flex-col select-text" style={{ background: 'var(--t-bg-active)' }}>
            <div className="flex items-center justify-between gap-2 px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--t-border)' }}>
              <span className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>
                历史对话 {historyList.length > 0 && `（${historyList.length}）`}
              </span>
              <button className="p-1 rounded" style={{ color: 'var(--t-text-muted)' }} onClick={() => setHistoryOpen(false)}>×</button>
            </div>

            <div className="overflow-y-auto flex-1 p-2">
              {historyList.length === 0 && (
                <div className="py-8 text-center text-xs" style={{ color: 'var(--t-text-muted)' }}>
                  还没有历史对话
                </div>
              )}
              {historyList.map(session => (
                <div
                  key={session.id}
                  className="group flex items-center gap-2 p-2 rounded cursor-pointer"
                  style={{ background: session.id === chatId ? 'var(--t-bg-hover)' : undefined }}
                  onClick={() => loadChat(session)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] truncate" style={{ color: 'var(--t-text)' }}>
                      {session.title}
                      {session.id === chatId && (
                        <span className="ml-1 text-[9px]" style={{ color: '#6366f1' }}>当前</span>
                      )}
                    </div>
                    <div className="text-[9px]" style={{ color: 'var(--t-text-faint)' }}>
                      {session.messages.length} 条 · {formatStashedAt(session.updatedAt)}
                    </div>
                  </div>
                  <button
                    className="px-1.5 py-0.5 rounded text-[10px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: '#ef4444' }}
                    onClick={e => { e.stopPropagation(); removeChat(session.id) }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 px-3 py-2 shrink-0" style={{ borderTop: '1px solid var(--t-border)' }}>
              <span className="text-[9px] leading-relaxed" style={{ color: 'var(--t-text-faint)' }}>
                自动清理：保留最近 {MAX_SESSIONS} 个、{MAX_AGE_DAYS} 天内的对话；截图不入历史
              </span>
              {historyList.length > 0 && (
                <button
                  className="px-2 py-1 rounded text-[10px] shrink-0"
                  style={{ color: '#ef4444', background: confirmClear ? 'rgba(239,68,68,0.15)' : 'transparent' }}
                  onClick={clearAllChats}
                >
                  {confirmClear ? '确认清空？' : '清空全部'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 图片预览：点击放大看，右键走浏览器原生"图片另存为" */}
        {preview && (
          <div
            className="absolute inset-0 z-[60] flex flex-col select-text"
            style={{ background: 'rgba(0,0,0,0.88)' }}
            onClick={() => setPreview(null)}
          >
            <div
              className="flex items-center justify-between gap-2 px-3 py-2 shrink-0"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
              onClick={e => e.stopPropagation()}
            >
              <span className="text-[11px] truncate" style={{ color: '#e0e0e0' }}>{preview.title}</span>
              <div className="flex items-center gap-1 shrink-0">
                <a
                  href={preview.dataUrl}
                  download={shotFilename(preview)}
                  className="px-2 py-1 rounded text-[10px]"
                  style={{ background: 'rgba(255,255,255,0.12)', color: '#e0e0e0' }}
                >
                  下载
                </a>
                <button
                  className="px-2 py-1 rounded text-[12px] leading-none"
                  style={{ color: '#aaa' }}
                  onClick={() => setPreview(null)}
                >
                  ×
                </button>
              </div>
            </div>
            {/* 长图逐屏拼出来会很高，预览区自己滚动 */}
            <div className="flex-1 overflow-auto p-2" onClick={e => e.stopPropagation()}>
              <img src={preview.dataUrl} alt={preview.title} style={{ width: '100%', display: 'block' }} />
            </div>
            <div
              className="px-3 py-1.5 text-center text-[9px] shrink-0"
              style={{ color: '#888' }}
              onClick={e => e.stopPropagation()}
            >
              右键图片可另存为本地文件 · 点空白处或按 ESC 关闭
            </div>
          </div>
        )}
    </div>
  )

  // 内嵌时宿主自己有边框和背景，不铺遮罩、也不该点外面就关掉
  if (embedded) return panel

  return (
    <div className="absolute inset-0 z-50 flex flex-col" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 backdrop-blur-[2px]" style={{ background: 'rgba(0,0,0,0.35)' }} />
      {panel}
    </div>
  )
}
