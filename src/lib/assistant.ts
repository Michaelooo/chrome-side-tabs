import type { AppConfig, AppTab, VirtualGroup, GroupColor } from '../types/entities'
import type { TabOrigin } from './provenance'
import { buildApiUrl } from './ai-client'
import { missingPermissions, permissionsForLookup } from './permissions'
import { readPages, MAX_READ_TABS } from './page-reader'
import { listRecentlyClosed } from './recently-closed'
import { getOrScan, formatForAI } from './perf-store'
import type { OptionalPermission } from './permissions'

export type AssistantAction =
  // 只读：把符合条件的标签指出来，不动任何东西
  | { action: 'select'; tabIds: number[] }
  // 清理
  | { action: 'close'; tabIds: number[] }
  | { action: 'stash'; tabIds: number[] }
  | { action: 'discard'; tabIds: number[] }
  | { action: 'reload'; tabIds: number[] }
  // 整理
  | { action: 'pin'; tabIds: number[]; pinned: boolean }
  | { action: 'mute'; tabIds: number[]; muted: boolean }
  | { action: 'group'; title: string; color: GroupColor; tabIds: number[] }
  | { action: 'activate'; tabIds: number[] }
  // 窗口
  | { action: 'moveToNewWindow'; tabIds: number[] }
  // 抓取
  | { action: 'screenshot'; tabIds: number[]; fullPage: boolean }
  | { action: 'exportBookmarks'; folderName: string; tabIds: number[] }
  // 打开新页面。用户贴一个 URL 过来时用这个，可以顺带截图。
  | { action: 'openTab'; urls: string[]; capture: 'none' | 'visible' | 'full' }
  // 恢复最近关闭的标签，sessionId 来自 recentlyClosed 查询结果
  | { action: 'restoreClosed'; sessionIds: string[] }

/** 需要先去查资料，查完再让模型回答一次 */
export interface AssistantLookup {
  history?: string
  bookmarks?: string
  /** 读取这些标签的页面正文（总结、比较、跨页搜索用） */
  readTabIds?: number[]
  /** 查最近关闭的标签列表 */
  recentlyClosed?: boolean
  /** 扫描各标签的内存与资源占用。5 分钟内扫过的会直接复用缓存 */
  scanPerf?: boolean
}

export interface AssistantReply {
  /** 给用户看的自然语言回答，永远要有 */
  answer: string
  actions: AssistantAction[]
  lookup?: AssistantLookup
  /** 被丢弃的操作及原因。静默失败最难查，所以要一条条说清楚 */
  dropped: string[]
}

/** 浏览器内置页无法注入脚本，也就无法截图 */
export function isCapturable(url: string): boolean {
  return !!url && /^https?:|^file:/i.test(url)
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export const ACTION_LABEL: Record<AssistantAction['action'], string> = {
  select: '高亮',
  close: '关闭',
  stash: '归档',
  discard: '休眠',
  reload: '重新加载',
  pin: '固定',
  mute: '静音',
  group: '归入分组',
  activate: '跳转到',
  moveToNewWindow: '移到新窗口',
  screenshot: '截图',
  exportBookmarks: '导出为书签',
  openTab: '打开网页',
  restoreClosed: '恢复关闭的页面',
}

/**
 * 能不打扰用户直接跑的操作：不改变任何标签状态，且没有副作用。
 * 整页截图不算——它会真的滚动页面，无限加载类页面可能被触发额外加载，
 * 这个风险要让用户自己决定。
 */
export function isAutoRunnable(action: AssistantAction): boolean {
  if (action.action === 'screenshot') return !action.fullPage
  return action.action === 'select' || action.action === 'activate'
}

/** 需要额外提醒风险的操作 */
export function actionWarning(action: AssistantAction): string | null {
  if (action.action === 'screenshot' && action.fullPage) {
    return '整页截图会滚动页面到底再滚回来。无限加载类页面（信息流、评论区）可能因此加载出更多内容。'
  }
  return null
}

/** 不可逆操作，UI 上要标红 */
export const DESTRUCTIVE_ACTIONS = new Set<AssistantAction['action']>(['close'])

const VALID_COLORS: GroupColor[] = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']

const SYSTEM_PROMPT = `你是浏览器标签助手，帮用户理解和整理他打开的一堆标签。

你有两种回应方式，通常要同时用：
1. answer —— 用自然语言回答用户。这个字段永远不能为空，哪怕你只是要执行一个命令，也要说明你做了什么。
2. actions —— 需要动手时给出操作列表。用户会先看到预览再确认，所以你可以放心提议。

可用操作：
- select：把符合条件的标签指出来高亮。用户在问"哪些…"的时候，用这个配合 answer，不要直接关。
- close：关闭标签（不可逆，慎用）
- stash：归档，关掉但存进归档抽屉，随时能恢复。比 close 安全，优先用这个。
- discard：休眠，释放内存但标签还在
- reload：重新加载
- pin：固定或取消固定，需要 pinned 字段
- mute：静音或取消静音，需要 muted 字段
- group：归成一组，需要 title（中文 2-6 字）和 color
- activate：跳转到某个标签
- moveToNewWindow：把这些标签移到一个新窗口
- screenshot：截图，需要 fullPage（true 尝试整页滚动拼接，false 只截可见区域）
- exportBookmarks：把这些标签存成一个书签文件夹，需要 folderName
- openTab：打开新网页。用户贴给你一个 URL、或者要求你打开某个地址时用这个。字段是 urls（数组）和 capture（"none" 不截图 / "visible" 截可见区域 / "full" 截整页）。**你完全可以打开网页，不要跟用户说你做不到。** 如果用户给的 URL 已经在标签列表里开着了，就直接用 screenshot 对那个标签操作，不用重复打开。
- restoreClosed：恢复最近关闭的标签页，需要 sessionIds（字符串数组，只能来自「最近关闭」查询结果，不能编造）。用户说"恢复刚关掉的页面""误关了"时，先用 lookup 查列表，下一轮再用这个恢复。

如果你需要先查资料才能回答，返回 lookup 字段，这一轮不要给 actions，我会查好再问你一次：
- {"lookup": {"history": "关键词"}} 查浏览历史
- {"lookup": {"bookmarks": "关键词"}} 查书签
- {"lookup": {"readTabIds": [123, 456]}} 读取这些标签的页面正文，最多 4 个。用户要总结页面、比较几个页面、问"哪个页面提到了 X"时用这个——你能读到真实内容，不要只凭标题猜
- {"lookup": {"recentlyClosed": true}} 查最近关闭的标签列表
- {"lookup": {"scanPerf": true}} 扫描各标签的内存与资源占用，拿到重量分、浪费分、JS 堆、DOM 节点数、图片位图体积。用户问"哪些标签吃内存""哪个页面最重""浏览器为什么这么卡""该关掉哪些最划算"时用这个——**不要凭标题猜测占用，标题看不出来一个页面有多重**

判断准则：
- **只要你在 answer 里说了要做某件事，就必须同时给出对应的 action。绝对不能只说不做**——用户看不到你的想法，只能看到实际发生的事。如果你做不到，就在 answer 里直接说做不到和原因，不要假装要去做。
- 标记了「不可截图」的标签是浏览器内置页（chrome:// 开头），截图对它无效。**用户说"当前网页""这个页面"时，指的绝不是浏览器内置页**——请用标了「最近访问#1」的那个标签，那才是他真正在看的页面。「所在窗口的活动标签」只说明它在某个窗口里恰好是激活状态，不代表用户在看它。
- 标签列表是所有窗口的合集，跨窗口的标签你都能操作。
- 用户贴 URL 过来时：先在列表里按 URL 找，找到就直接对那个标签操作；找不到就用 openTab 打开它。**不要说"我无法打开网页"，你可以。**
- **分屏（拆分视图）这件事你做不了**：Chrome 没有开放创建分屏的接口，扩展只能读到"谁和谁正在分屏"。用户要求分屏时，不要假装执行，直接告诉他手动方法：右键标签页 →「将标签页拆分到右侧」，或把一个标签拖到窗口右半边；取消分屏是右键 →「退出拆分视图」。如果标签标了"正与…分屏显示"，说明它已经在分屏里了。
- 用户问"哪些…"、"有没有…"、"帮我看看…"时，这是提问，用 answer 认真回答，配 select 指出来，不要擅自关闭
- 判断"摸鱼""无用""该清理"这类主观问题时，大胆给出你的判断和理由，不要因为不确定就拒绝回答。可以在 answer 里说明你的判断依据
- 用户明确说"关掉""删掉"时才用 close，否则优先 stash
- tabIds 必须来自我给你的标签列表，绝对不能编造。**必须是 JSON 数字数组，例如 "tabIds": [123, 456]，不要写成字符串 ["123"]，也不要用 tabId 单数形式。**
- 纯问答（用户只是想知道信息，不需要你动手）时，actions 给空数组就行，不要为了凑数塞一个操作
- answer 用中文，简洁，不要客套话，不要重复用户的问题

严格输出 JSON，不要输出 Markdown 代码块。每个操作对象的操作名字段**必须叫 "action"**，不要用 type / name / tool。

输出示例：
{"answer":"正在给当前页面截整页图。","actions":[{"action":"screenshot","tabIds":[789],"fullPage":true}]}
{"answer":"这两个是重复的，帮你归档了。","actions":[{"action":"stash","tabIds":[123,456]}]}
{"answer":"这 3 个标签超过一天没访问了。","actions":[{"action":"select","tabIds":[1,2,3]}]}
{"answer":"帮你打开并截图了。","actions":[{"action":"openTab","urls":["https://example.com"],"capture":"full"}]}
{"answer":"你一共开了 31 个标签，其中 12 个是文档类。","actions":[]}
{"answer":"帮你恢复刚关闭的那个页面。","actions":[{"action":"restoreClosed","sessionIds":["12"]}]}`

/** 从一段文本里抠出第一个括号平衡的 JSON 对象 */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 模型不一定听话。三级降级：
 * 直接解析 → 从文本里抠 JSON → 当成纯聊天。
 * 最后一级很重要：模型只是想跟你说句话时，不该甩用户一行红色报错。
 */
function parseJsonContent(content: string): unknown {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const candidate = fenced ? fenced[1].trim() : trimmed

  try {
    return JSON.parse(candidate)
  } catch { /* 继续降级 */ }

  const extracted = extractJsonObject(candidate)
  if (extracted) return extracted

  return { answer: trimmed, actions: [] }
}

function formatIdle(lastAccessed: number): string {
  const mins = Math.floor((Date.now() - lastAccessed) / 60000)
  if (mins < 60) return `${mins}分钟`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时`
  return `${Math.floor(hours / 24)}天`
}


/**
 * 上下文是这个助手聪不聪明的关键。
 * 光给标题和 URL，它没法判断"哪些在摸鱼"——闲置时长、重复情况、
 * 分组归属、从哪儿点进来的，这些才是判断依据。
 */
export function buildTabContext(
  tabs: AppTab[],
  groups: VirtualGroup[],
  origins: Record<number, TabOrigin>,
): string {
  const groupOf = new Map<number, string>()
  for (const g of groups) {
    for (const id of g.tabIds) groupOf.set(id, g.title)
  }

  const urlCount = new Map<string, number>()
  for (const t of tabs) urlCount.set(t.url, (urlCount.get(t.url) ?? 0) + 1)

  // 按最近访问排序，让"最近访问的那个网页""刚才那个页面"这类指代有据可依。
  // 浏览器内置页排除在外——用户说"当前网页"时指的从来不是 chrome:// 页面。
  const sorted = [...tabs].sort((a, b) => b.lastAccessed - a.lastAccessed)
  const recentRank = new Map<number, number>()
  let rank = 0
  for (const t of sorted) {
    if (!isCapturable(t.url)) continue
    recentRank.set(t.id, ++rank)
    if (rank >= 5) break
  }

  const windowIds = [...new Set(tabs.map(t => t.windowId))]

  // Chrome 140+ 的原生分屏。扩展只能读不能建，但知道谁跟谁在分屏很有用
  const SPLIT_NONE = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1
  const splitPartner = new Map<number, string>()
  const bySplit = new Map<number, AppTab[]>()
  for (const t of tabs) {
    if (t.splitViewId == null || t.splitViewId === SPLIT_NONE) continue
    const list = bySplit.get(t.splitViewId) ?? []
    list.push(t)
    bySplit.set(t.splitViewId, list)
  }
  for (const list of bySplit.values()) {
    for (const t of list) {
      const other = list.find(x => x.id !== t.id)
      if (other) splitPartner.set(t.id, other.title || other.url)
    }
  }

  return sorted.map(t => {
    const bits = [
      `id:${t.id}`,
      t.title || '无标题',
      t.url,
      `闲置${formatIdle(t.lastAccessed)}`,
    ]
    if (recentRank.has(t.id)) bits.push(`最近访问#${recentRank.get(t.id)}`)
    if (groupOf.has(t.id)) bits.push(`组:${groupOf.get(t.id)}`)
    if (windowIds.length > 1) bits.push(`窗口${windowIds.indexOf(t.windowId) + 1}`)
    if (t.active) bits.push('所在窗口的活动标签')
    if (splitPartner.has(t.id)) bits.push(`正与「${splitPartner.get(t.id)!.slice(0, 20)}」分屏显示`)
    if (t.pinned) bits.push('已固定')
    if (t.audible) bits.push(t.muted ? '已静音' : '有声音')
    if (t.discarded) bits.push('已休眠')
    if (!isCapturable(t.url)) bits.push('浏览器内置页/不可截图')
    if ((urlCount.get(t.url) ?? 0) > 1) bits.push(`重复${urlCount.get(t.url)}次`)
    const from = origins[t.id]?.openerTitle
    if (from) bits.push(`来自:${from.slice(0, 20)}`)
    return bits.join(' | ')
  }).join('\n')
}

function canon(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 模型给操作起名的方式很随意：action / type / name / tool 都可能，
 * 名字本身也可能是 take_screenshot、archive 这类同义词。
 * 这里统一归一化到我们的动作名，认不出来才算失败。
 */
const NAME_ALIASES: Record<string, AssistantAction['action']> = (() => {
  const map: Record<string, AssistantAction['action']> = {}
  for (const key of Object.keys(ACTION_LABEL) as AssistantAction['action'][]) {
    map[canon(key)] = key
  }
  const extra: Record<string, AssistantAction['action']> = {
    takescreenshot: 'screenshot', capture: 'screenshot', capturescreenshot: 'screenshot',
    capturetab: 'screenshot', screencapture: 'screenshot', fullpagescreenshot: 'screenshot',
    screenshotfullpage: 'screenshot', snapshot: 'screenshot',
    closetab: 'close', closetabs: 'close', remove: 'close', removetabs: 'close',
    archive: 'stash', stashtabs: 'stash', save: 'stash',
    suspend: 'discard', sleep: 'discard', unload: 'discard',
    refresh: 'reload', reloadtabs: 'reload',
    highlight: 'select', selecttabs: 'select', show: 'select', find: 'select', list: 'select',
    focus: 'activate', switchto: 'activate', gototab: 'activate', jump: 'activate',
    creategroup: 'group', grouptabs: 'group',
    newwindow: 'moveToNewWindow', movetowindow: 'moveToNewWindow',
    open: 'openTab', openurl: 'openTab', navigate: 'openTab', opentabs: 'openTab',
    restore: 'restoreClosed', reopen: 'restoreClosed', undoclose: 'restoreClosed',
    restoretab: 'restoreClosed', reopentab: 'restoreClosed',
    bookmark: 'exportBookmarks', savebookmarks: 'exportBookmarks',
    setmuted: 'mute', unmute: 'mute',
    setpinned: 'pin', unpin: 'pin',
  }
  return { ...map, ...extra }
})()

function pickActionName(a: Record<string, unknown>): AssistantAction['action'] | null {
  for (const key of ['action', 'type', 'name', 'tool', 'op', 'operation', 'command', 'function']) {
    const v = a[key]
    if (typeof v === 'string' && v.trim()) {
      const hit = NAME_ALIASES[canon(v)]
      if (hit) return hit
    }
  }
  return null
}

/**
 * 模型对 tabId 的写法五花八门：数字、数字字符串、tabId 单数、id……
 * 这里宽进：能认出来的都认，认不出来的说清楚为什么。
 */
function pickIds(a: Record<string, unknown>, liveIds: Set<number>): { ids: number[]; sawAny: boolean } {
  const candidates: unknown[] = []
  for (const key of ['tabIds', 'tabIDs', 'tab_ids', 'ids', 'tabId', 'tab_id', 'id']) {
    const v = a[key]
    if (Array.isArray(v)) candidates.push(...v)
    else if (v !== undefined && v !== null) candidates.push(v)
  }

  const parsed = candidates
    .map(v => {
      if (typeof v === 'number') return v
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
      return NaN
    })
    .filter(n => Number.isFinite(n))

  return {
    ids: [...new Set(parsed.filter(n => liveIds.has(n)))],
    sawAny: parsed.length > 0,
  }
}

function sanitize(raw: unknown, tabs: AppTab[]): AssistantReply {
  const liveIds = new Set(tabs.map(t => t.id))
  const obj = raw as { answer?: unknown; actions?: unknown; lookup?: unknown }
  const actions: AssistantAction[] = []
  const dropped: string[] = []

  // 用户说"当前网页"却没给出有效 ID 时的兜底目标
  const fallbackTarget = [...tabs]
    .filter(t => isCapturable(t.url))
    .sort((a, b) => b.lastAccessed - a.lastAccessed)[0]

  // actions 有时会是对象而不是数组，有时整条就是个字符串
  const rawActions: unknown[] = Array.isArray(obj.actions)
    ? obj.actions
    : obj.actions && typeof obj.actions === 'object'
      ? Object.values(obj.actions as Record<string, unknown>)
      : []

  for (const item of rawActions) {
    {
      const a = (typeof item === 'string' ? { action: item } : item) as Record<string, unknown>
      if (!a || typeof a !== 'object') {
        dropped.push(`操作格式不对：${JSON.stringify(item).slice(0, 60)}`)
        continue
      }

      const name = pickActionName(a)
      if (!name) {
        dropped.push(`认不出这是什么操作：${JSON.stringify(a).slice(0, 80)}`)
        continue
      }

      // openTab 靠 URL 工作，没有 tabIds，单独处理
      if (name === 'openTab') {
        // urls 也可能写成 url 单数
        const rawUrls: unknown[] = []
        for (const key of ['urls', 'url', 'links', 'link']) {
          const v = a[key]
          if (Array.isArray(v)) rawUrls.push(...v)
          else if (v !== undefined && v !== null) rawUrls.push(v)
        }
        const urls = rawUrls
          .filter((u): u is string => typeof u === 'string')
          .map(u => u.trim())
          .filter(u => /^https?:\/\//i.test(u))
          .slice(0, 8)
        if (urls.length === 0) {
          dropped.push('打开网页：没有给出合法的 http(s) 地址')
          continue
        }
        const capture = a.capture === 'full' ? 'full' : a.capture === 'visible' ? 'visible' : 'none'
        actions.push({ action: 'openTab', urls, capture })
        continue
      }

      // restoreClosed 用 sessionId（字符串）而不是 tabId，单独处理
      if (name === 'restoreClosed') {
        const raw: unknown[] = []
        for (const key of ['sessionIds', 'sessionId', 'ids', 'id']) {
          const v = a[key]
          if (Array.isArray(v)) raw.push(...v)
          else if (v !== undefined && v !== null) raw.push(v)
        }
        const sessionIds = [...new Set(
          raw
            .map(v => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
            .filter(v => v.length > 0),
        )].slice(0, 10)
        if (sessionIds.length === 0) {
          dropped.push('恢复关闭的页面：没有给出 sessionId')
          continue
        }
        actions.push({ action: 'restoreClosed', sessionIds })
        continue
      }

      const picked = pickIds(a, liveIds)
      let ids = picked.ids

      if (ids.length === 0) {
        // 截图和跳转几乎总是指"我现在看的这个页面"，兜底到最近访问的可截图标签，
        // 比直接丢掉更符合用户意图。其余操作宁可不做。
        if ((name === 'screenshot' || name === 'activate' || name === 'select') && fallbackTarget) {
          ids = [fallbackTarget.id]
        } else {
          dropped.push(picked.sawAny
            ? `${ACTION_LABEL[name]}：给的标签 ID 不存在`
            : `${ACTION_LABEL[name]}：没有指定标签`)
          continue
        }
      }

      switch (name) {
        case 'group':
          actions.push({
            action: 'group',
            title: typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 12) : '新分组',
            color: VALID_COLORS.includes(a.color as GroupColor) ? (a.color as GroupColor) : 'blue',
            tabIds: ids,
          })
          break
        case 'pin':
          actions.push({ action: 'pin', tabIds: ids, pinned: a.pinned !== false })
          break
        case 'mute':
          actions.push({ action: 'mute', tabIds: ids, muted: a.muted !== false })
          break
        case 'screenshot':
          actions.push({ action: 'screenshot', tabIds: ids.slice(0, 4), fullPage: a.fullPage === true })
          break
        case 'exportBookmarks':
          actions.push({
            action: 'exportBookmarks',
            tabIds: ids,
            folderName: typeof a.folderName === 'string' && a.folderName.trim()
              ? a.folderName.trim().slice(0, 40)
              : `Sift ${new Date().toLocaleDateString('zh-CN')}`,
          })
          break
        default:
          actions.push({ action: name as 'select', tabIds: ids })
      }
    }
  }

  let lookup: AssistantLookup | undefined
  if (obj.lookup && typeof obj.lookup === 'object') {
    const l = obj.lookup as Record<string, unknown>
    const next: AssistantLookup = {}
    if (typeof l.history === 'string' && l.history.trim()) next.history = l.history.trim()
    if (typeof l.bookmarks === 'string' && l.bookmarks.trim()) next.bookmarks = l.bookmarks.trim()
    if (Array.isArray(l.readTabIds)) {
      const ids = [...new Set(
        l.readTabIds
          .map(v => typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)
          .filter(n => Number.isFinite(n) && liveIds.has(n)),
      )].slice(0, MAX_READ_TABS)
      if (ids.length > 0) next.readTabIds = ids
    }
    if (l.recentlyClosed === true) next.recentlyClosed = true
    if (l.scanPerf === true) next.scanPerf = true
    if (Object.keys(next).length > 0) lookup = next
  }

  if (dropped.length > 0) {
    console.warn('[Sift] 助手有操作被丢弃：', dropped, '原始返回：', raw)
  }

  return {
    answer: typeof obj.answer === 'string' && obj.answer.trim() ? obj.answer.trim() : '我没太理解，换个说法试试？',
    actions,
    lookup,
    dropped,
  }
}

async function callModel(
  messages: Array<{ role: string; content: string }>,
  config: AppConfig,
): Promise<{ raw: unknown | null; error?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45000)

  const post = (jsonMode: boolean) => fetch(buildApiUrl(config.ai.baseURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.model || 'deepseek-chat',
      messages,
      temperature: 0.3,
      max_tokens: 2000,
      // 强制 JSON 输出是最有效的一招，但不是所有兼容端点都支持，失败了退回普通模式
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: controller.signal,
  })

  try {
    let response = await post(true)
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      response = await post(false)
    }
    clearTimeout(timeout)

    if (!response.ok) {
      const errText = await response.text()
      return { raw: null, error: `API 返回 ${response.status}: ${errText.slice(0, 120)}` }
    }
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return { raw: null, error: 'AI 返回空内容' }
    return { raw: parseJsonContent(content) }
  } catch (err) {
    clearTimeout(timeout)
    if ((err as Error).name === 'AbortError') return { raw: null, error: 'AI 请求超时 (45s)' }
    return { raw: null, error: `网络错误: ${(err as Error).message}` }
  }
}

async function runLookup(
  lookup: AssistantLookup,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const parts: string[] = []

  if (lookup.scanPerf) {
    try {
      const { scan, fromCache } = await getOrScan({
        onProgress: (done, total) => onProgress?.(`正在测量标签占用 ${done}/${total}...`),
      })
      parts.push(formatForAI(scan) + (fromCache ? '\n（复用了几分钟前的扫描结果，未重新测量）' : ''))
    } catch (err) {
      parts.push(`性能扫描失败：${(err as Error).message}`)
    }
  }

  if (lookup.history) {
    try {
      const items = await chrome.history.search({
        text: lookup.history,
        maxResults: 20,
        startTime: Date.now() - 30 * 24 * 3600 * 1000,
      })
      parts.push(`浏览历史（${lookup.history}）：\n` + (items.length
        ? items.map(i => `- ${i.title || '无标题'} | ${i.url} | 访问${i.visitCount ?? 0}次`).join('\n')
        : '（没有结果）'))
    } catch (err) {
      parts.push(`浏览历史查询失败：${(err as Error).message}`)
    }
  }

  if (lookup.bookmarks) {
    try {
      const items = await chrome.bookmarks.search(lookup.bookmarks)
      parts.push(`书签（${lookup.bookmarks}）：\n` + (items.length
        ? items.filter(i => i.url).slice(0, 20).map(i => `- ${i.title} | ${i.url}`).join('\n')
        : '（没有结果）'))
    } catch (err) {
      parts.push(`书签查询失败：${(err as Error).message}`)
    }
  }

  if (lookup.readTabIds?.length) {
    const pages = await readPages(lookup.readTabIds)
    for (const p of pages) {
      if (p.error) {
        parts.push(`【${p.title || p.url}】读取失败：${p.error}`)
        continue
      }
      parts.push(
        `【${p.title}】${p.url}` +
        (p.wasDiscarded ? '（原本已休眠，为读取内容已唤醒）' : '') +
        `\n${p.text}` +
        (p.truncated ? '\n（正文过长，已截断）' : ''),
      )
    }
  }

  if (lookup.recentlyClosed) {
    try {
      const items = await listRecentlyClosed()
      parts.push('最近关闭（sessionId | 标题 | 关闭于）：\n' + (items.length
        ? items.map(i =>
            `- ${i.sessionId} | ${i.title}${i.url ? ' | ' + i.url : ''} | ${formatIdle(i.closedAt)}前`,
          ).join('\n')
        : '（没有记录）'))
    } catch (err) {
      parts.push(`最近关闭列表获取失败：${(err as Error).message}`)
    }
  }

  return parts.join('\n\n')
}

export async function askAssistant(
  question: string,
  tabs: AppTab[],
  groups: VirtualGroup[],
  origins: Record<number, TabOrigin>,
  history: ChatTurn[],
  config: AppConfig,
  /** 查询阶段的进度。性能扫描可能要跑几秒，不报进度看起来像卡死 */
  onProgress?: (msg: string) => void,
): Promise<{ data: AssistantReply | null; error?: string; missingPermissions?: OptionalPermission[] }> {
  if (!config.ai.enabled || !config.ai.apiKey || !config.ai.baseURL) {
    return { data: null, error: 'AI 未配置，请先在设置页填写 API 信息' }
  }

  const context = buildTabContext(tabs, groups, origins)
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `当前共 ${tabs.length} 个标签：\n${context}` },
    // 只带最近几轮，避免上下文无限膨胀
    ...history.slice(-10).map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: question },
  ]

  const first = await callModel(messages, config)
  if (!first.raw) return { data: null, error: first.error }

  const reply = sanitize(first.raw, tabs)

  // 模型说它需要查历史/书签，查完再问一次
  if (reply.lookup) {
    // 历史和书签是可选权限，没授权就不能查。这里不弹窗——
    // chrome.permissions.request 必须在用户手势里调用，
    // 而这会儿手势早就没了。交给 UI 摆一个授权按钮。
    const needed = permissionsForLookup(reply.lookup)
    const missing = await missingPermissions(needed)
    if (missing.length > 0) {
      return { data: reply, missingPermissions: missing }
    }

    const found = await runLookup(reply.lookup, onProgress)
    onProgress?.('思考中...')
    const second = await callModel([
      ...messages,
      { role: 'assistant', content: JSON.stringify({ answer: reply.answer, lookup: reply.lookup }) },
      { role: 'system', content: `查询结果：\n${found}\n\n现在请正式回答用户，不要再返回 lookup。` },
    ], config)
    if (second.raw) return { data: sanitize(second.raw, tabs) }
  }

  return { data: reply }
}
