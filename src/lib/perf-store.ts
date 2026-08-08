import type { ScanResult } from './perf-probe'
import { scanTabs, getHostname, formatBytes, formatCount, formatIdle } from './perf-probe'
import { queryAllTabs } from './tab-manager'

// 性能扫描要往每个标签注入探针，代价不小。这里把最近一次结果放进会话存储，
// 让性能页和 AI 助手共用同一份——助手连着追问几句不该把所有标签重扫几遍。
// 用 session 而不是 local：浏览器一关这份数据就该失效，它描述的是此刻的状态。

const KEY = 'perf_scan'

/** 超过这个时间就认为数据过期，重新扫 */
export const FRESH_MS = 5 * 60 * 1000

export interface CachedScan {
  result: ScanResult
  scannedAt: number
}

export async function putScan(result: ScanResult): Promise<void> {
  await chrome.storage.session.set({ [KEY]: { result, scannedAt: Date.now() } })
}

export async function getScan(): Promise<CachedScan | null> {
  const r = await chrome.storage.session.get(KEY)
  return (r[KEY] as CachedScan) ?? null
}

export async function clearScan(): Promise<void> {
  await chrome.storage.session.remove(KEY)
}

/** 缓存够新就直接用，否则重扫并写回缓存 */
export async function getOrScan(
  opts: { maxAgeMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ scan: CachedScan; fromCache: boolean }> {
  const maxAge = opts.maxAgeMs ?? FRESH_MS
  const cached = await getScan()
  if (cached && Date.now() - cached.scannedAt < maxAge) {
    return { scan: cached, fromCache: true }
  }

  const result = await scanTabs(await queryAllTabs(), opts.onProgress)
  await putScan(result)
  return { scan: { result, scannedAt: Date.now() }, fromCache: false }
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s} 秒前`
  return `${Math.round(s / 60)} 分钟前`
}

/**
 * 压成给模型看的紧凑文本。
 * 几十个标签的完整指标太占 token，模型真正需要的是排序和量级，不是每个字段的精确值。
 */
export function formatForAI(scan: CachedScan, maxRows = 25): string {
  const { metrics, stats } = scan.result
  const measured = metrics.filter(m => m.measured).sort((a, b) => b.weight - a.weight)

  const lines: string[] = [
    `标签性能扫描（${ago(scan.scannedAt)}测的，${stats.measured} 个测到 / ${stats.skipped} 个跳过 / ${stats.failed} 个失败）`,
    '重量分 = 该标签相对最重的那个有多重（0-100）；浪费分 = 重量 × 闲置程度，固定/有声音/当前活动的标签浪费分恒为 0。',
    'Chrome 拿不到可信的单标签内存，所以这里给的是相对排名，不是绝对 MB。',
    '',
  ]

  const totalHeap = measured.reduce((s, m) => s + m.jsHeap, 0)
  const totalBitmap = measured.reduce((s, m) => s + m.imgBitmapBytes, 0)
  const totalDom = measured.reduce((s, m) => s + m.domNodes, 0)
  lines.push(`合计：JS 堆 ${formatBytes(totalHeap)} | 图片位图 ${formatBytes(totalBitmap)} | DOM 节点 ${formatCount(totalDom)}`, '')

  lines.push(`按重量排序的前 ${Math.min(maxRows, measured.length)} 个：`)
  for (const m of measured.slice(0, maxRows)) {
    const bits = [
      `id:${m.tabId}`,
      (m.title || m.url).slice(0, 40),
      getHostname(m.url),
      `重量${m.weight}`,
      `浪费${m.waste}`,
      `堆${formatBytes(m.jsHeap)}`,
      `DOM${formatCount(m.domNodes)}`,
      `图${formatBytes(m.imgBitmapBytes)}`,
      `闲置${formatIdle(m.lastAccessed)}`,
    ]
    if (m.iframes > 0) bits.push(`iframe${m.iframes}`)
    if (m.mediaCount > 0) bits.push(`音视频${m.mediaCount}`)
    if (m.pinned) bits.push('已固定')
    if (m.active) bits.push('活动中')
    if (m.audible) bits.push('有声音')
    lines.push('- ' + bits.join(' | '))
  }

  // 没测到的也要交代，否则模型会以为这些标签不存在
  const skipped = metrics.filter(m => !m.measured)
  if (skipped.length > 0) {
    const byReason = new Map<string, number>()
    for (const m of skipped) {
      const r = m.skipReason ?? '未知原因'
      byReason.set(r, (byReason.get(r) ?? 0) + 1)
    }
    lines.push('', `未测量的 ${skipped.length} 个：` + [...byReason].map(([r, n]) => `${r} ×${n}`).join('、'))
  }

  return lines.join('\n')
}
