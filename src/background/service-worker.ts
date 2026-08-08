import { initTabWatcher, refreshCurrentWindow } from './tab-watcher'
import { initSuspendManager } from './suspend-manager'
import { initStashManager } from './stash-manager'
import { initBadge } from './badge'
import { applyCurrentMode } from '../lib/mode'
import { storage } from '../lib/storage'
import { logger } from '../lib/logger'

// 侧边栏和浮球面板都是 extension page，可以直接调 chrome.tabs，
// 不需要经 service worker 中转，所以这里只保留后台自己要做的事：
// 生命周期初始化、标签事件监听、自动休眠、自动归档，
// 外加两件只有后台能做的：告诉浮球它在哪个窗口、接管工具栏图标点击。

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed:', details.reason)

  applyCurrentMode()

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
  }

  refreshCurrentWindow()
})

chrome.runtime.onStartup.addListener(() => {
  applyCurrentMode()
  refreshCurrentWindow()
})

// 浮球面板要按窗口读写分组，必须知道自己嵌在哪个窗口里。
// 内容脚本问不到自己的 tabId，只有后台能从 sender 拿到可信答案。
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'side-tabs:whoami') {
    respond({ tabId: sender.tab?.id, windowId: sender.tab?.windowId })
    return true
  }
  return false
})

/**
 * 打开面板。三个入口共用这一条路径：工具栏图标、快捷键、以及注入不了的页面上的兜底。
 * origin 决定面板从哪儿冒出来——把手点开的从左边滑出，快捷键召唤的居中弹出，
 * 让空间上有连续感。
 */
async function openPanel(tab: chrome.tabs.Tab | undefined, origin: 'handle' | 'center') {
  const { ui } = await storage.config.get()

  // 侧栏模式下这些入口就该开侧栏，不该在页面上挂东西
  if (ui.mode !== 'orb') {
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId })
    return
  }

  try {
    if (tab?.id == null) throw new Error('no tab id')
    await chrome.tabs.sendMessage(tab.id, { type: 'side-tabs:toggle', origin })
  } catch {
    // chrome:// / Web Store / PDF 这些页面注入不了内容脚本，
    // 退回到开一个独立扩展页，保证扩展在任何页面都够得着
    await chrome.tabs.create({ url: chrome.runtime.getURL('orb.html?standalone=1') })
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  // 侧栏模式下这个事件根本不会触发（openPanelOnActionClick 接管了）
  await openPanel(tab, 'handle')
})

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  await openPanel(tab, 'center')
})

initTabWatcher()
initSuspendManager()
initStashManager()
initBadge()
