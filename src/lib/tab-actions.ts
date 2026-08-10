import type { AppTab, GroupColor } from '../types/entities'
import type { AssistantAction } from './assistant'
import { ACTION_LABEL } from './assistant'
import { stash } from './stash'
import { restoreSessionId } from './recently-closed'
import { HOST_ATTR } from './mode'

export interface Shot {
  tabId: number
  title: string
  dataUrl: string
}

export type Progress = (text: string) => void

export interface ExecuteResult {
  /** 执行过程中产出的截图，交给 UI 展示 */
  shots: Shot[]
  notes: string[]
}

// captureVisibleTab 有约 2 次/秒的配额，超了会直接抛错
const CAPTURE_INTERVAL_MS = 600
const MAX_VIEWPORTS = 20

// Chrome 的 canvas 单边上限 16384px，总面积上限约 16384²。
// 20 屏 × 900px × 2 倍屏 = 36000px，很容易撞上，超了会得到一张全空白的图。
const MAX_CANVAS_DIM = 16384
const MAX_CANVAS_AREA = 16384 * 16384

/** 算出把长图压进 canvas 限制所需的缩放系数，1 表示不用压 */
function fitScale(width: number, height: number): number {
  const scale = Math.min(
    1,
    MAX_CANVAS_DIM / width,
    MAX_CANVAS_DIM / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  )
  return scale > 0 && Number.isFinite(scale) ? scale : 1
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 只截当前可见区域。captureVisibleTab 只对窗口里的活动标签生效。 */
async function captureVisible(tab: AppTab, onProgress?: Progress): Promise<Shot | null> {
  onProgress?.(`正在截图：${tab.title || tab.url}`)
  await chrome.tabs.update(tab.id, { active: true })
  await toggleOwnUI(tab.id, true)
  await sleep(250)
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    return { tabId: tab.id, title: tab.title || tab.url, dataUrl }
  } catch {
    return null
  } finally {
    await toggleOwnUI(tab.id, false)
  }
}

const SCROLLER_ATTR = 'data-sidetabs-scroller'

/**
 * 把扩展自己挂在页面上的界面藏起来。
 *
 * 内容脚本的宿主是 position:fixed 的，逐屏滚动截长图时会出现在每一屏里。
 * 下面 scrollAndMask 那套页面 fixed 元素的遮罩救不了它，有两个原因：
 * 宿主挂在 documentElement 上（body 的兄弟节点），不在 `body *` 的范围内；
 * 而且那套遮罩第一屏是故意不生效的（要保留页头）。
 * 扩展自己的界面不该出现在任何一屏，所以单独、无条件地藏。
 */
function setOwnUIHidden(attr: string, hidden: boolean) {
  const marked = Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`))
  // 内容脚本宿主直接挂在 documentElement 下，与标准的 head/body 同级。
  // 扩展 reload 后旧宿主没有 attr，只按它独有的整屏 fixed + 最高层级组合识别。
  const legacy = Array.from(document.documentElement.children)
    .filter((el): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false
      const s = el.style
      return s.position === 'fixed'
        && s.inset === '0px'
        && s.pointerEvents === 'none'
        && s.zIndex === '2147483647'
    })

  for (const el of new Set([...marked, ...legacy])) {
    if (hidden) {
      if (el.dataset.siftCaptureDisplay == null) {
        el.dataset.siftCaptureDisplay = el.style.display || '__empty__'
      }
      el.style.display = 'none'
    } else {
      const display = el.dataset.siftCaptureDisplay
      if (display == null) continue
      el.style.display = display === '__empty__' ? '' : display
      delete el.dataset.siftCaptureDisplay
    }
  }
}

/** 截图前后各调一次。页面注入不进去（chrome:// 等）就静默跳过 */
async function toggleOwnUI(tabId: number, hidden: boolean) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: setOwnUIHidden,
    args: [HOST_ATTR, hidden],
  }).catch(() => undefined)
}

interface PageMetrics {
  /** 截图要裁的区域（视口坐标），文档滚动时就是整个视口 */
  rect: { x: number; y: number; width: number; height: number }
  scrollHeight: number
  clientHeight: number
  dpr: number
  originalScroll: number
  /** 是否是内部容器在滚，而不是整个文档 */
  container: boolean
}

/**
 * 找出页面上真正在滚动的东西。
 *
 * 很多现代站点（在线文档、后台系统这类 SPA）不滚 document，
 * 而是滚内部某个 overflow:auto 的容器。此时 documentElement.scrollHeight
 * 恒等于视口高度，window.scrollTo 也完全无效——按文档滚动的思路去截，
 * 结果就是反复截同一屏。
 */
function probePageForCapture(attr: string): PageMetrics {
  const de = document.documentElement
  const dpr = window.devicePixelRatio || 1

  document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr))

  // 文档本身能滚就用文档
  if (de.scrollHeight > de.clientHeight + 4) {
    return {
      rect: { x: 0, y: 0, width: de.clientWidth, height: window.innerHeight },
      scrollHeight: de.scrollHeight,
      clientHeight: window.innerHeight,
      dpr,
      originalScroll: window.scrollY,
      container: false,
    }
  }

  // 否则找面积最大的可滚动容器
  let best: Element | null = null
  let bestScore = 0
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const style = getComputedStyle(el)
    const oy = style.overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    if (el.scrollHeight <= el.clientHeight + 4) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 100 || rect.height < 100) continue
    const score = rect.width * rect.height
    if (score > bestScore) { bestScore = score; best = el }
  }

  if (!best) {
    return {
      rect: { x: 0, y: 0, width: de.clientWidth, height: window.innerHeight },
      scrollHeight: window.innerHeight,
      clientHeight: window.innerHeight,
      dpr,
      originalScroll: window.scrollY,
      container: false,
    }
  }

  // 打个标记，后续每次滚动都靠它重新找到这个元素
  best.setAttribute(attr, '1')
  const rect = best.getBoundingClientRect()
  return {
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    scrollHeight: best.scrollHeight,
    clientHeight: best.clientHeight,
    dpr,
    originalScroll: best.scrollTop,
    container: true,
  }
}

/** 滚到指定位置，顺便把 fixed/sticky 元素藏起来，避免每屏都糊一层页头 */
function scrollAndMask(attr: string, top: number, hideOverlays: boolean): number {
  const scroller = document.querySelector(`[${attr}]`)

  if (hideOverlays) {
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const style = getComputedStyle(el)
      if (style.position !== 'fixed' && style.position !== 'sticky') continue
      const he = el as HTMLElement
      if (he.dataset.sidetabsHidden) continue
      he.dataset.sidetabsHidden = he.style.visibility || 'auto'
      he.style.visibility = 'hidden'
    }
  }

  if (scroller) {
    scroller.scrollTop = top
    return scroller.scrollTop
  }
  window.scrollTo(0, top)
  return window.scrollY
}

/** 收尾：滚回原位、恢复被藏起来的元素、清掉标记 */
function restorePage(attr: string, originalScroll: number) {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-sidetabs-hidden]'))) {
    const prev = el.dataset.sidetabsHidden
    el.style.visibility = prev && prev !== 'auto' ? prev : ''
    delete el.dataset.sidetabsHidden
  }
  const scroller = document.querySelector(`[${attr}]`)
  if (scroller) {
    scroller.scrollTop = originalScroll
    scroller.removeAttribute(attr)
  } else {
    window.scrollTo(0, originalScroll)
  }
}

/**
 * 整页截图：找到滚动容器 → 逐屏滚动截取 → 按实际滚动位置拼接。
 * 受 captureVisibleTab 的配额限制，最多 MAX_VIEWPORTS 屏，再长就截断。
 */
async function captureFullPage(
  tab: AppTab,
  onProgress?: Progress,
  notes?: string[],
): Promise<Shot | null> {
  onProgress?.(`正在打开：${tab.title || tab.url}`)
  // 非聚焦窗口的截图在部分平台会失败或截到旧内容
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
  await chrome.tabs.update(tab.id, { active: true })
  await sleep(300)

  let m: PageMetrics
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probePageForCapture,
      args: [SCROLLER_ATTR],
    })
    m = res.result as PageMetrics
  } catch {
    return captureVisible(tab, onProgress)
  }

  const total = Math.ceil(m.scrollHeight / m.clientHeight)
  const steps = Math.min(total, MAX_VIEWPORTS)
  if (steps <= 1) return captureVisible(tab, onProgress)
  if (total > MAX_VIEWPORTS) {
    notes?.push(`页面太长（约 ${total} 屏），只截了前 ${MAX_VIEWPORTS} 屏`)
  }

  const canvasHeight = Math.min(m.scrollHeight, m.clientHeight * steps)
  const fullW = m.rect.width * m.dpr
  const fullH = canvasHeight * m.dpr

  // 超出 canvas 上限就整体降采样，宽高同比例缩，画面不变形
  const scale = fitScale(fullW, fullH)
  if (scale < 1) {
    notes?.push(`长图超出画布上限，已按 ${Math.round(scale * 100)}% 缩放输出`)
  }

  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(fullW * scale)),
    Math.max(1, Math.round(fullH * scale)),
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) return captureVisible(tab, onProgress)
  ctx.imageSmoothingQuality = 'high'

  // 整轮截图期间一直藏着，否则每一屏都会糊上一层我们自己的面板
  await toggleOwnUI(tab.id, true)

  let captured = 0
  try {
    for (let i = 0; i < steps; i++) {
      onProgress?.(`正在截图 ${i + 1}/${steps} 屏`)

      let actual = i * m.clientHeight
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrollAndMask,
          // 第一屏保留页头，之后藏掉，免得每屏都重复一条悬浮导航
          args: [SCROLLER_ATTR, i * m.clientHeight, i > 0],
        })
        if (typeof res.result === 'number') actual = res.result
      } catch { /* 滚不动就按理论位置画 */ }

      await sleep(CAPTURE_INTERVAL_MS)

      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
        // 从整屏截图里裁出滚动容器那一块，按"实际滚到了多少"落到长图上。
        // 用实际值而不是理论值，最后一屏没滚满时才不会错位或重影。
        ctx.drawImage(
          bitmap,
          m.rect.x * m.dpr, m.rect.y * m.dpr,
          m.rect.width * m.dpr, m.rect.height * m.dpr,
          0, actual * m.dpr * scale,
          m.rect.width * m.dpr * scale, m.rect.height * m.dpr * scale,
        )
        bitmap.close()
        captured++
      } catch {
        break
      }

      // 已经滚到底了，再截也是重复
      if (actual + m.clientHeight >= m.scrollHeight - 4) break
    }
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: restorePage,
      args: [SCROLLER_ATTR, m.originalScroll],
    }).catch(() => undefined)
    await toggleOwnUI(tab.id, false)
  }

  if (captured === 0) return captureVisible(tab, onProgress)

  onProgress?.('正在拼接图片')
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const dataUrl = await new Promise<string>(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
  return { tabId: tab.id, title: tab.title || tab.url, dataUrl }
}

/** 等标签加载完成，最多等 15 秒 */
async function waitForLoad(tabId: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return true
    } catch {
      return false
    }
    await sleep(300)
  }
  return false
}

function tabToApp(tab: chrome.tabs.Tab): AppTab {
  return {
    id: tab.id!,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title ?? '',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    muted: tab.mutedInfo?.muted ?? false,
    splitViewId: tab.splitViewId,
    discarded: tab.discarded ?? false,
    lastAccessed: tab.lastAccessed ?? Date.now(),
  }
}

async function exportBookmarks(tabs: AppTab[], folderName: string): Promise<string> {
  const folder = await chrome.bookmarks.create({ title: folderName })
  let n = 0
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) continue
    try {
      await chrome.bookmarks.create({ parentId: folder.id, title: tab.title || tab.url, url: tab.url })
      n++
    } catch { /* 单条失败不影响其余 */ }
  }
  return `已存成书签文件夹「${folderName}」，共 ${n} 条`
}

/**
 * 执行助手给出的操作。所有需要确认的操作在 UI 层已经拿到用户点头了，
 * 这里只负责落地，并把过程中产生的东西（截图、说明）交回去。
 */
export async function executeActions(
  actions: AssistantAction[],
  tabs: AppTab[],
  onGroup: (title: string, color: GroupColor, tabIds: number[]) => Promise<void>,
  onProgress?: Progress,
): Promise<ExecuteResult> {
  const byId = new Map(tabs.map(t => [t.id, t]))
  const shots: Shot[] = []
  const notes: string[] = []

  for (const action of actions) {
    onProgress?.(`${ACTION_LABEL[action.action]}中...`)
    const targets = 'tabIds' in action
      ? action.tabIds.map(id => byId.get(id)).filter((t): t is AppTab => !!t)
      : []

    switch (action.action) {
      case 'select':
        break // 高亮由 UI 处理，不做实际操作

      case 'close':
        if (action.tabIds.length) await chrome.tabs.remove(action.tabIds)
        break

      case 'stash': {
        const stashable = targets.filter(t => t.url && !t.url.startsWith('chrome://'))
        if (stashable.length === 0) break
        await stash.add(stashable.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })))
        await chrome.tabs.remove(stashable.map(t => t.id))
        notes.push(`已归档 ${stashable.length} 个标签`)
        break
      }

      case 'discard':
        for (const id of action.tabIds) {
          try { await chrome.tabs.discard(id) } catch { /* 可能已关闭 */ }
        }
        break

      case 'reload':
        for (const id of action.tabIds) {
          try { await chrome.tabs.reload(id) } catch { /* 同上 */ }
        }
        break

      case 'pin':
        for (const id of action.tabIds) {
          try { await chrome.tabs.update(id, { pinned: action.pinned }) } catch { /* 同上 */ }
        }
        break

      case 'mute':
        for (const id of action.tabIds) {
          try { await chrome.tabs.update(id, { muted: action.muted }) } catch { /* 同上 */ }
        }
        break

      case 'activate':
        if (action.tabIds[0] != null) {
          const tab = byId.get(action.tabIds[0])
          if (tab) {
            await chrome.windows.update(tab.windowId, { focused: true })
            await chrome.tabs.update(tab.id, { active: true })
          }
        }
        break

      case 'group':
        await onGroup(action.title, action.color, action.tabIds)
        break

      case 'moveToNewWindow':
        if (action.tabIds.length) {
          const [first, ...rest] = action.tabIds
          const win = await chrome.windows.create({ tabId: first })
          if (win?.id && rest.length) {
            await chrome.tabs.move(rest, { windowId: win.id, index: -1 })
          }
          notes.push(`已把 ${action.tabIds.length} 个标签移到新窗口`)
        }
        break

      case 'screenshot': {
        for (const tab of targets.slice(0, 4)) {
          if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
            notes.push(`${tab.title || tab.url}：浏览器内置页无法截图`)
            continue
          }
          const shot = action.fullPage
            ? await captureFullPage(tab, onProgress, notes)
            : await captureVisible(tab, onProgress)
          if (shot) shots.push(shot)
          else notes.push(`${tab.title || tab.url}：截图失败`)
        }
        break
      }

      case 'exportBookmarks':
        notes.push(await exportBookmarks(targets, action.folderName))
        break

      case 'openTab': {
        for (const url of action.urls) {
          onProgress?.(`正在打开：${url}`)
          try {
            const created = await chrome.tabs.create({ url, active: action.capture !== 'none' })
            if (!created.id) continue

            if (action.capture === 'none') {
              notes.push(`已打开 ${url}`)
              continue
            }

            const loaded = await waitForLoad(created.id)
            if (!loaded) notes.push(`${url} 加载较慢，截的可能不完整`)

            const fresh = tabToApp(await chrome.tabs.get(created.id))
            const shot = action.capture === 'full'
              ? await captureFullPage(fresh, onProgress, notes)
              : await captureVisible(fresh, onProgress)
            if (shot) shots.push(shot)
            else notes.push(`${url} 截图失败`)
          } catch (err) {
            notes.push(`打开 ${url} 失败：${(err as Error).message}`)
          }
        }
        break
      }

      case 'restoreClosed': {
        let ok = 0
        for (const id of action.sessionIds) {
          onProgress?.('正在恢复关闭的页面...')
          if (await restoreSessionId(id)) ok++
        }
        notes.push(ok > 0
          ? `已恢复 ${ok} 个关闭的页面`
          : '没能恢复：记录可能已过期，去归档抽屉的「刚关闭」里看看')
        break
      }
    }
  }

  return { shots, notes }
}
