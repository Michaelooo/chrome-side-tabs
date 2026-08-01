import { initTabWatcher, refreshCurrentWindow } from './tab-watcher'
import { initSuspendManager } from './suspend-manager'
import { initStashManager } from './stash-manager'
import { logger } from '../lib/logger'

// 侧边栏是 extension page，可以直接调 chrome.tabs，
// 不需要经 service worker 中转，所以这里只保留后台自己要做的事：
// 生命周期初始化、标签事件监听、自动休眠、自动归档。

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed:', details.reason)

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
  }

  refreshCurrentWindow()
})

chrome.runtime.onStartup.addListener(() => {
  refreshCurrentWindow()
})

initTabWatcher()
initSuspendManager()
initStashManager()
