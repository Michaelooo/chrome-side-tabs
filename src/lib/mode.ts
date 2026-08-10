import type { UIMode } from '../types/entities'
import { storage } from './storage'

/** 内容脚本与后台之间的消息。只有这三条，不是通用中转层 */
export type OrbMessage =
  | { type: 'side-tabs:mode'; mode: UIMode }
  | { type: 'side-tabs:toggle'; origin?: 'handle' | 'center' }
  | { type: 'side-tabs:whoami' }

export interface WhoAmI {
  tabId?: number
  windowId?: number
}

/**
 * 内容脚本宿主在页面上的标记。截图逻辑靠它把扩展自己的界面藏起来。
 * 放在这里而不是各写一份：内容脚本模块有副作用（挂监听、读配置），
 * 截图那边不能 import 它，两边分别写字面量迟早会漂移。
 */
export const HOST_ATTR = 'data-sift-host'

/**
 * 让浏览器状态与设置里的形态对齐。
 * 侧栏模式：侧栏可用，点工具栏图标直接开侧栏。
 * 浮球模式：侧栏禁用，工具栏图标交给 service worker 的 onClicked 处理。
 */
export async function applyMode(mode: UIMode): Promise<void> {
  const isSidePanel = mode === 'sidepanel'
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: isSidePanel })
  await chrome.sidePanel.setOptions({ enabled: isSidePanel })
}

/** 读设置并对齐。service worker 启动和安装时调 */
export async function applyCurrentMode(): Promise<UIMode> {
  const { ui } = await storage.config.get()
  await applyMode(ui.mode)
  return ui.mode
}

/**
 * 通知所有已打开标签页的内容脚本切换形态。
 * 内容脚本是随页面加载注入的，切设置时已经在跑的那批收不到 storage 变化，
 * 只能主动广播，否则用户得把每个标签都刷一遍。
 * 收不到的（chrome:// 等注入不了的页面）直接忽略。
 */
export async function broadcastMode(mode: UIMode): Promise<void> {
  const tabs = await chrome.tabs.query({})
  await Promise.all(tabs.map(async t => {
    if (t.id == null) return
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'side-tabs:mode', mode } satisfies OrbMessage)
    } catch {
      /* 这个页面没有内容脚本，正常 */
    }
  }))
}

/** 设置页切换形态时调：存盘 + 对齐浏览器 + 通知已开的页面 */
export async function setMode(mode: UIMode): Promise<void> {
  const config = await storage.config.get()
  await storage.config.set({ ui: { ...config.ui, mode } })
  await applyMode(mode)
  await broadcastMode(mode)
}
