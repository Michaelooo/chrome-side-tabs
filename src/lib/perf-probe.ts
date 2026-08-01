import type { AppTab } from '../types/entities'

// 单个页面（含子 frame）的原始探针数据
export interface FrameSample {
  jsHeap: number
  jsHeapAvailable: boolean
  domNodes: number
  iframes: number
  imgCount: number
  imgBitmapBytes: number
  resourceCount: number
  transferBytes: number
  mediaCount: number
  loadMs: number
  probeMs: number
}

export interface TabMetrics {
  tabId: number
  title: string
  url: string
  favIconUrl?: string
  lastAccessed: number
  pinned: boolean
  active: boolean
  audible?: boolean
  // 测量结果
  measured: boolean
  skipReason?: string
  frames: number
  jsHeap: number
  jsHeapAvailable: boolean
  domNodes: number
  iframes: number
  imgCount: number
  imgBitmapBytes: number
  resourceCount: number
  transferBytes: number
  mediaCount: number
  loadMs: number
  // 探针自身开销：页面主线程实际被占用的时间
  probeMs: number
  // 从发起注入到拿到结果的总往返耗时
  roundTripMs: number
  // 评分（扫描完成后统一归一化填充）
  weight: number
  waste: number
}

export interface ScanStats {
  totalTabs: number
  measured: number
  skipped: number
  failed: number
  wallClockMs: number
  totalProbeMs: number
  avgProbeMs: number
  maxProbeMs: number
  avgRoundTripMs: number
}

export interface ScanResult {
  metrics: TabMetrics[]
  stats: ScanStats
}

// 无法注入脚本的页面：扩展页、浏览器内置页、商店等
const UNINJECTABLE_SCHEME = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|devtools|view-source|chrome-untrusted|blob|data):/i
const UNINJECTABLE_HOST = /(^|\.)chromewebstore\.google\.com$|^chrome\.google\.com$/i

export function getSkipReason(tab: AppTab): string | null {
  if (!tab.url) return '无 URL'
  // 已休眠的标签当前占用接近 0，注入会把它唤醒并重新加载整个页面，
  // 那才是真正的性能负担，所以一律跳过。
  if (tab.discarded) return '已休眠（跳过以免唤醒）'
  if (UNINJECTABLE_SCHEME.test(tab.url)) return '浏览器内置页，无法测量'
  try {
    if (UNINJECTABLE_HOST.test(new URL(tab.url).hostname)) return '扩展商店页，无法测量'
  } catch {
    return 'URL 无法解析'
  }
  if (tab.url.endsWith('.pdf')) return 'PDF 阅读器，无法测量'
  return null
}

/**
 * 注入到页面里执行的探针。必须是自包含函数：不能引用外部作用域的任何变量。
 *
 * 设计约束：
 * - 纯一次性同步执行，不注册任何监听器、不留驻留代码
 * - 不读取会触发 reflow 的属性（naturalWidth/naturalHeight 是内在尺寸，安全）
 * - 不做 longtask 采样，那需要探针驻留，且后台标签被节流后测出来恒为 0
 */
function pageProbe(): FrameSample {
  const t0 = performance.now()

  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory

  const imgs = document.images
  let imgBitmapBytes = 0
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i]
    // 解码后的位图按 RGBA 4 字节/像素估算，这通常才是标签内存的大头
    imgBitmapBytes += (im.naturalWidth || 0) * (im.naturalHeight || 0) * 4
  }

  const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  let transferBytes = 0
  for (let i = 0; i < res.length; i++) transferBytes += res[i].transferSize || 0

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined

  return {
    jsHeap: mem ? mem.usedJSHeapSize : 0,
    jsHeapAvailable: !!mem,
    domNodes: document.getElementsByTagName('*').length,
    iframes: document.querySelectorAll('iframe').length,
    imgCount: imgs.length,
    imgBitmapBytes,
    resourceCount: res.length,
    transferBytes,
    mediaCount: document.querySelectorAll('video,audio').length,
    loadMs: nav ? Math.max(0, Math.round(nav.loadEventEnd - nav.startTime)) : 0,
    probeMs: performance.now() - t0,
  }
}

function emptyMetrics(tab: AppTab): TabMetrics {
  return {
    tabId: tab.id,
    title: tab.title || tab.url || '新标签',
    url: tab.url,
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed,
    pinned: tab.pinned,
    active: tab.active,
    audible: tab.audible,
    measured: false,
    frames: 0,
    jsHeap: 0,
    jsHeapAvailable: false,
    domNodes: 0,
    iframes: 0,
    imgCount: 0,
    imgBitmapBytes: 0,
    resourceCount: 0,
    transferBytes: 0,
    mediaCount: 0,
    loadMs: 0,
    probeMs: 0,
    roundTripMs: 0,
    weight: 0,
    waste: 0,
  }
}

/**
 * 聚合多个 frame 的采样。
 * - 结构类指标（DOM 节点、图片、资源）跨 frame 累加
 * - jsHeap 取最大值而非累加：同进程的 frame 共用一个堆，累加会重复计算。
 *   取最大值是保守的低估，宁可少报也不虚报。
 */
function mergeFrames(samples: FrameSample[]): Omit<FrameSample, 'probeMs'> & { probeMs: number } {
  const merged = {
    jsHeap: 0,
    jsHeapAvailable: false,
    domNodes: 0,
    iframes: 0,
    imgCount: 0,
    imgBitmapBytes: 0,
    resourceCount: 0,
    transferBytes: 0,
    mediaCount: 0,
    loadMs: 0,
    probeMs: 0,
  }
  for (const s of samples) {
    merged.jsHeap = Math.max(merged.jsHeap, s.jsHeap)
    merged.jsHeapAvailable = merged.jsHeapAvailable || s.jsHeapAvailable
    merged.domNodes += s.domNodes
    merged.iframes += s.iframes
    merged.imgCount += s.imgCount
    merged.imgBitmapBytes += s.imgBitmapBytes
    merged.resourceCount += s.resourceCount
    merged.transferBytes += s.transferBytes
    merged.mediaCount += s.mediaCount
    merged.loadMs = Math.max(merged.loadMs, s.loadMs)
    merged.probeMs += s.probeMs
  }
  return merged
}

async function injectProbe(tabId: number, world: 'MAIN' | 'ISOLATED') {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world,
    func: pageProbe,
  })
}

async function probeTab(tab: AppTab): Promise<TabMetrics> {
  const base = emptyMetrics(tab)
  const skip = getSkipReason(tab)
  if (skip) return { ...base, skipReason: skip }

  const t0 = performance.now()
  try {
    let results: chrome.scripting.InjectionResult<FrameSample>[]
    let heapTrusted = true
    try {
      // MAIN world 复用页面自己的 JS 上下文，不额外创建 isolate，
      // 且能拿到页面真实的 JS 堆。
      results = await injectProbe(tab.id, 'MAIN') as chrome.scripting.InjectionResult<FrameSample>[]
    } catch {
      // 少数站点的 CSP 会拦掉 MAIN world 注入。降级到 ISOLATED：
      // DOM / 资源时间线是共享的，指标照样准，只有 JS 堆读的是隔离环境的堆，不可信。
      results = await injectProbe(tab.id, 'ISOLATED') as chrome.scripting.InjectionResult<FrameSample>[]
      heapTrusted = false
    }

    const samples = results.map(r => r.result).filter((s): s is FrameSample => !!s)
    if (samples.length === 0) {
      return { ...base, skipReason: '页面未返回数据', roundTripMs: performance.now() - t0 }
    }

    const merged = mergeFrames(samples)
    return {
      ...base,
      measured: true,
      frames: samples.length,
      ...merged,
      jsHeap: heapTrusted ? merged.jsHeap : 0,
      jsHeapAvailable: heapTrusted && merged.jsHeapAvailable,
      roundTripMs: performance.now() - t0,
    }
  } catch (err) {
    return {
      ...base,
      skipReason: `注入失败：${(err as Error).message}`,
      roundTripMs: performance.now() - t0,
    }
  }
}

// 简单并发池，避免同时打满太多渲染进程
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

const WEIGHTS = {
  imgBitmapBytes: 0.35,
  jsHeap: 0.3,
  domNodes: 0.2,
  iframes: 0.1,
  mediaCount: 0.05,
}

// 相对排名比绝对 MB 更有意义：Chrome 拿不到可信的单标签内存，
// 但"谁比谁重"是能测准的。
function scoreMetrics(metrics: TabMetrics[]) {
  const measured = metrics.filter(m => m.measured)
  if (measured.length === 0) return

  const max = {
    imgBitmapBytes: Math.max(...measured.map(m => m.imgBitmapBytes), 1),
    jsHeap: Math.max(...measured.map(m => m.jsHeap), 1),
    domNodes: Math.max(...measured.map(m => m.domNodes), 1),
    iframes: Math.max(...measured.map(m => m.iframes), 1),
    mediaCount: Math.max(...measured.map(m => m.mediaCount), 1),
  }

  const now = Date.now()
  for (const m of metrics) {
    if (!m.measured) continue
    const weight =
      (m.imgBitmapBytes / max.imgBitmapBytes) * WEIGHTS.imgBitmapBytes +
      (m.jsHeap / max.jsHeap) * WEIGHTS.jsHeap +
      (m.domNodes / max.domNodes) * WEIGHTS.domNodes +
      (m.iframes / max.iframes) * WEIGHTS.iframes +
      (m.mediaCount / max.mediaCount) * WEIGHTS.mediaCount
    m.weight = Math.round(weight * 100)

    // 浪费分 = 重量 × 闲置程度。固定和正在播放声音的标签不算浪费。
    const idleHours = (now - m.lastAccessed) / 3600000
    const idleFactor = m.active || m.pinned || m.audible ? 0 : Math.min(idleHours / 24, 1)
    m.waste = Math.round(m.weight * idleFactor)
  }
}

export async function scanTabs(
  tabs: AppTab[],
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResult> {
  const t0 = performance.now()
  let done = 0

  const metrics = await mapWithConcurrency(tabs, 5, async tab => {
    const m = await probeTab(tab)
    done++
    onProgress?.(done, tabs.length)
    return m
  })

  scoreMetrics(metrics)

  const measured = metrics.filter(m => m.measured)
  const failed = metrics.filter(m => !m.measured && m.roundTripMs > 0)
  const probeTimes = measured.map(m => m.probeMs)
  const totalProbeMs = probeTimes.reduce((a, b) => a + b, 0)

  return {
    metrics,
    stats: {
      totalTabs: tabs.length,
      measured: measured.length,
      skipped: metrics.length - measured.length - failed.length,
      failed: failed.length,
      wallClockMs: Math.round(performance.now() - t0),
      totalProbeMs: Math.round(totalProbeMs),
      avgProbeMs: measured.length ? totalProbeMs / measured.length : 0,
      maxProbeMs: probeTimes.length ? Math.max(...probeTimes) : 0,
      avgRoundTripMs: measured.length
        ? measured.reduce((a, b) => a + b.roundTripMs, 0) / measured.length
        : 0,
    },
  }
}

// --- 进程归属推断 ---
// Chrome 按 site（scheme + eTLD+1）做进程隔离，同 site 的标签共用渲染进程，
// 内存是共享的。这里不引入公共后缀表，用"末两段域名"近似，界面上明确标注为近似值。
export function getSiteKey(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.hostname.split('.')
    const registrable = parts.length > 2 ? parts.slice(-2).join('.') : u.hostname
    return `${u.protocol}//${registrable}`
  } catch {
    return url
  }
}

export function getHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatCount(n: number): string {
  if (!n) return '—'
  if (n < 1000) return String(n)
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

export function formatIdle(lastAccessed: number): string {
  const mins = Math.floor((Date.now() - lastAccessed) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
