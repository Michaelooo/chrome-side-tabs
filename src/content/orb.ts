import type { WhoAmI } from '../lib/mode'
import { storage } from '../lib/storage'

// 页面上的入口。它本身不碰 chrome.tabs——那些 API 内容脚本调不到。
// 点开后挂一个指向 orb.html 的 iframe，那是扩展页，能直接调全套扩展 API，
// 于是 lib/ 里的逻辑原样复用，不需要把一切都塞进消息里中转。
//
// 位置选在左边缘中部而不是左下角：左下角是 cookie 横幅、返回顶部、客服气泡的
// 法定领地，用户对那儿有横幅盲区。中部高度没有这个问题。
//
// 面板刻意做成「浮动卡片」而不是贴边全高栏：不贴边、不全高、不推布局。
// 用户已经开着原生垂直标签栏了，再来一根贴边全高的栏就是横向被吃两次。

type PanelOrigin = 'handle' | 'center'

const HANDLE_W = 26
const HANDLE_W_OPEN = 34
const HANDLE_H = 60
/** 面板与视口左边缘的距离。要避开展开态的把手，也要留出缝——有缝它才读作浮卡而不是第二根侧栏 */
const PANEL_GAP = 46
const MAX_W = 360
const MAX_H = 520

const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin
const SPRING = 'cubic-bezier(.2,.9,.25,1.15)'

let host: HTMLDivElement | null = null
let shadow: ShadowRoot | null = null
let handle: HTMLButtonElement | null = null
let frame: HTMLIFrameElement | null = null
let whoami: WhoAmI | null = null

const STYLE = `
/* 一块实体的深色片，不是一条要靠猜的细缝。
   左边缘那道渐变色条给它静止时的颜色身份，深色片在浅色页和深色页上都立得住。 */
.handle {
  position: absolute; left: 0; top: 50%;
  width: ${HANDLE_W}px; height: ${HANDLE_H}px;
  margin: 0; padding: 0; border: 0;
  border-radius: 0 10px 10px 0;
  background: #16161a;
  opacity: 0.8; cursor: pointer; overflow: hidden;
  pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  transform: translateY(-50%);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 3px 0 14px rgba(0,0,0,0.30);
  transition: width 240ms ${SPRING}, opacity 200ms ease, box-shadow 240ms ease;
  animation: st-handle-in 560ms ${SPRING} both;
}
.handle::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: linear-gradient(180deg, #818cf8, #22d3ee);
}
.handle:hover, .handle[data-open="1"], .handle[data-busy="1"] {
  width: ${HANDLE_W_OPEN}px; opacity: 1;
  box-shadow:
    0 0 0 1px rgba(129,140,248,0.55),
    0 0 0 4px rgba(99,102,241,0.14),
    5px 0 22px rgba(0,0,0,0.4);
}

@keyframes st-handle-in {
  from { opacity: 0; transform: translate(-10px, -50%); }
  to   { opacity: .8; transform: translate(0, -50%); }
}
@keyframes st-sort {
  0%, 100% { width: 13px; }
  50%      { width: 6px; }
}

/* 三条错位横杠，展开时对齐并点亮——这个扩展干的就是把乱标签变整齐 */
.mark {
  display: flex; flex-direction: column; gap: 3.5px; align-items: flex-start;
  width: 13px; margin-left: 3px;
}
.mark i {
  display: block; height: 2px; border-radius: 1px;
  width: var(--w); margin-left: var(--x);
  background: #9a9aa6;
  transition: width 280ms ${SPRING}, margin-left 280ms ${SPRING}, background 200ms ease;
  transition-delay: var(--d);
}
.handle:hover .mark i, .handle[data-open="1"] .mark i {
  margin-left: 0;
  background: linear-gradient(90deg, #818cf8, #22d3ee);
}
.handle:hover .mark i:nth-child(1), .handle[data-open="1"] .mark i:nth-child(1) { width: 13px; }
.handle:hover .mark i:nth-child(2), .handle[data-open="1"] .mark i:nth-child(2) { width: 9px; }
.handle:hover .mark i:nth-child(3), .handle[data-open="1"] .mark i:nth-child(3) { width: 11px; }

.handle[data-busy="1"] .mark i {
  margin-left: 0;
  background: linear-gradient(90deg, #818cf8, #22d3ee);
  animation: st-sort 900ms ease-in-out infinite;
  animation-delay: var(--d);
}

.panel {
  position: absolute;
  border: 0; border-radius: 14px; background: #1c1c1c;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 20px 60px rgba(0,0,0,0.55);
  opacity: 0; pointer-events: auto;
  transition: opacity 220ms ${SPRING}, transform 220ms ${SPRING};
}
/* 把手点开的：从左边滑出，锚在把手旁边 */
.panel[data-origin="handle"] { transform: translateX(-14px); }
.panel[data-origin="handle"][data-in="1"] { opacity: 1; transform: none; }
/* 快捷键召唤的：居中偏上缩放弹出 */
.panel[data-origin="center"] { transform: translateX(-50%) scale(0.96); }
.panel[data-origin="center"][data-in="1"] { opacity: 1; transform: translateX(-50%) scale(1); }

@media (prefers-reduced-motion: reduce) {
  .handle, .mark, .mark i, .panel { animation: none !important; transition-duration: 1ms !important; }
}
`

const MARK = `
<span class="mark">
  <i style="--w:10px; --x:1px; --d:0ms"></i>
  <i style="--w:6px;  --x:0px; --d:45ms"></i>
  <i style="--w:8px;  --x:3px; --d:90ms"></i>
</span>`

function mount() {
  if (host) return

  host = document.createElement('div')
  // 宿主必须铺满视口：子元素用百分比定位（把手 top:50%、居中面板 left:50%），
  // 宿主要是零尺寸，百分比会全部塌缩到 0。
  // pointer-events:none 让它不拦截页面点击，把手和面板各自再收回来。
  // all:initial 挡住页面样式（继承属性会穿透 shadow 边界），必须写在最前面。
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'

  shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  shadow.appendChild(style)

  handle = document.createElement('button')
  handle.className = 'handle'
  // 不在这写快捷键：它可能被用户改过，写死就成了假话。真实绑定在设置页里显示
  handle.title = 'Sift — AI 整理标签'
  handle.innerHTML = MARK
  handle.addEventListener('click', e => { e.stopPropagation(); togglePanel('handle') })
  shadow.appendChild(handle)

  document.documentElement.appendChild(host)

  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('fullscreenchange', onFullscreen)
}

function unmount() {
  closePanel()
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('fullscreenchange', onFullscreen)
  host?.remove()
  host = null
  shadow = null
  handle = null
}

// 全屏看视频时不该有东西挂在上面
function onFullscreen() {
  if (!host) return
  const full = !!document.fullscreenElement
  host.style.display = full ? 'none' : ''
  if (full) closePanel()
}

function onDocClick(e: MouseEvent) {
  if (!frame || !host) return
  // 面板里的点击不会冒泡到页面（iframe 吞掉了），能走到这儿的都是面板外
  if (e.composedPath().includes(host)) return
  closePanel()
}

function onKeyDown(e: KeyboardEvent) {
  // 面板打开时焦点通常在 iframe 里，ESC 由面板自己 postMessage 回来；
  // 这里兜住焦点还在页面上的情况
  if (e.key === 'Escape' && frame) closePanel()
}

async function togglePanel(origin: PanelOrigin) {
  if (frame) closePanel()
  else await openPanel(origin)
}

async function openPanel(origin: PanelOrigin) {
  if (!shadow || frame) return

  // 面板要按窗口读写分组。内容脚本问不到自己的 tabId，
  // 只有 service worker 能从 sender 拿到可信答案。
  if (!whoami) {
    try {
      whoami = await chrome.runtime.sendMessage({ type: 'side-tabs:whoami' })
    } catch {
      return // 扩展上下文失效（刚重载过），下次再试
    }
  }

  const width = Math.min(MAX_W, window.innerWidth - PANEL_GAP - 20)
  const height = Math.min(MAX_H, window.innerHeight - 80)

  const url = new URL(chrome.runtime.getURL('orb.html'))
  if (whoami?.windowId != null) url.searchParams.set('windowId', String(whoami.windowId))
  if (whoami?.tabId != null) url.searchParams.set('tabId', String(whoami.tabId))

  frame = document.createElement('iframe')
  frame.className = 'panel'
  frame.dataset.origin = origin
  frame.src = url.toString()
  frame.style.width = `${width}px`
  frame.style.height = `${height}px`

  if (origin === 'handle') {
    frame.style.left = `${PANEL_GAP}px`
    frame.style.top = `${Math.max(24, (window.innerHeight - height) / 2)}px`
  } else {
    // 居中偏上：整屏正中会显得沉，偏上一点更像被召唤出来的
    frame.style.left = '50%'
    frame.style.top = `${Math.max(24, (window.innerHeight - height) * 0.32)}px`
  }

  shadow.appendChild(frame)
  handle?.setAttribute('data-open', '1')
  // 下一帧再加 data-in，否则初始态和终态在同一帧，过渡不会跑
  requestAnimationFrame(() => frame?.setAttribute('data-in', '1'))
}

function closePanel() {
  frame?.remove()
  frame = null
  handle?.removeAttribute('data-open')
  handle?.removeAttribute('data-busy')
}

// 面板是 iframe，里面的事件出不来，收起和忙碌状态都得它自己喊
window.addEventListener('message', e => {
  if (e.origin !== EXT_ORIGIN) return
  if (!frame || e.source !== frame.contentWindow) return
  if (e.data?.source !== 'side-tabs') return

  if (e.data.type === 'close') closePanel()
  // 整理跑起来时让横杠排序，面板外面也看得出在干活
  if (e.data.type === 'busy') {
    if (e.data.busy) handle?.setAttribute('data-busy', '1')
    else handle?.removeAttribute('data-busy')
  }
})

chrome.runtime.onMessage.addListener((msg) => {
  // 设置页切了形态，已经打开的页面靠这条广播即时生效，不用挨个刷新
  if (msg?.type === 'side-tabs:mode') {
    if (msg.mode === 'orb') mount()
    else unmount()
  }
  // 工具栏图标和快捷键都走这条，origin 决定面板从哪儿冒出来
  if (msg?.type === 'side-tabs:toggle') {
    if (!host) mount()
    togglePanel(msg.origin === 'center' ? 'center' : 'handle')
  }
  return false
})

// 侧栏模式下这个脚本立即退场，除了一次 storage 读取什么都不做
storage.config.get()
  .then(({ ui }) => { if (ui.mode === 'orb') mount() })
  .catch(() => { /* 扩展上下文失效 */ })
