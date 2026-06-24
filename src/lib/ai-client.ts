import type { AppConfig } from '../types/entities'
import type { AIGroupResponse } from '../types/ai'
import { sha1Hex } from './hash'
import { storage } from './storage'

export const SYSTEM_PROMPT = `你是浏览器标签分组助手。用户会给你一组打开的浏览器标签（编号+标题+URL），你需要按语义和用途将它们分成几组。

分组规则：
1. 按内容主题聚类，尽量合并相似主题
2. 最多只能分 5 组，如果主题较多则合并相近的
3. 每组至少 2 个标签，孤立的标签放入最接近的组
4. 组标题要简洁直观，用中文，2-6 个字
5. 从 [blue, red, yellow, green, pink, purple, cyan, orange] 中选颜色
6. 严格输出 JSON，不要输出任何其他内容

输出格式：
{ "groups": [{ "title": string, "color": string, "indices": number[] }] }`

function buildApiUrl(baseURL: string): string {
  let url = baseURL.trim().replace(/\/+$/, '')
  // If user provided baseURL without path, append /v1
  // If user already has a path like /v1, just append /chat/completions
  if (!url.includes('/v1') && !url.includes('/v2') && !url.includes('/chat')) {
    url += '/v1'
  }
  if (!url.endsWith('/chat/completions')) {
    url += '/chat/completions'
  }
  return url
}

export async function groupTabsWithAI(
  tabs: Array<{ index: number; title: string; url: string }>,
  config: AppConfig,
  forceRefresh = false,
): Promise<{ data: AIGroupResponse | null; error?: string }> {
  const cacheKey = await sha1Hex(tabs.map(t => t.url).sort().join('\n'))

  // Check cache first
  if (!forceRefresh) {
    const cached = await storage.aiCache.get(cacheKey)
    if (cached) {
      console.log('[SideTabs] AI cache hit for key:', cacheKey.slice(0, 8))
      return { data: mapCachedResult(cached.result, tabs) }
    }
  }

  if (!config.ai.enabled || !config.ai.apiKey || !config.ai.baseURL) {
    console.warn('[SideTabs] AI not configured:', { enabled: config.ai.enabled, hasKey: !!config.ai.apiKey, hasURL: !!config.ai.baseURL })
    return { data: null, error: 'AI 未配置，请先在设置页填写 API 信息' }
  }

  const apiUrl = buildApiUrl(config.ai.baseURL)
  const userContent = tabs.map(t => `[${t.index}] ${t.title} | ${t.url}`).join('\n')

  console.log('[SideTabs] Calling AI:', apiUrl, 'with', tabs.length, 'tabs')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000) // 30s timeout

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(config.ai.customPrompt?.trim() ? [{ role: 'system', content: config.ai.customPrompt.trim() }] : []),
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errText = await response.text()
      console.error('[SideTabs] AI request failed:', response.status, errText)
      return { data: null, error: `API 返回 ${response.status}: ${errText.slice(0, 100)}` }
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      console.error('[SideTabs] AI returned empty content:', JSON.stringify(data).slice(0, 200))
      return { data: null, error: 'AI 返回空内容' }
    }

    console.log('[SideTabs] AI response:', content.slice(0, 200))

    const parsed: AIGroupResponse = JSON.parse(content)

    // Cache the result
    await storage.aiCache.put({
      key: cacheKey,
      result: parsed.groups.map(g => ({
        title: g.title,
        color: g.color,
        urls: g.indices.map(i => tabs[i]?.url).filter(Boolean) as string[],
      })),
      model: config.ai.model,
      createdAt: Date.now(),
    })

    return { data: parsed }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error('[SideTabs] AI request timed out (30s)')
      return { data: null, error: 'AI 请求超时 (30s)' }
    } else {
      console.error('[SideTabs] AI grouping error:', err)
      return { data: null, error: `网络错误: ${(err as Error).message}` }
    }
  }
}

export interface CleanupCandidateInput {
  id: number
  title: string
  url: string
  reasons: string[]
  idleMinutes: number
}

export interface CleanupDecision {
  tabId: number
  decision: 'close' | 'keep' | 'unsure'
  reason: string
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return JSON.parse(fenced ? fenced[1] : trimmed)
}

export async function classifyTabsForCleanup(
  candidates: CleanupCandidateInput[],
  config: AppConfig,
): Promise<{ data: CleanupDecision[] | null; error?: string }> {
  if (!config.ai.enabled || !config.ai.apiKey || !config.ai.baseURL) {
    return { data: null, error: 'AI 未配置，请先在设置页填写 API 信息' }
  }

  const maxCandidates = 40
  const limitedCandidates = candidates.slice(0, maxCandidates)
  const apiUrl = buildApiUrl(config.ai.baseURL)
  const userContent = limitedCandidates.map(c => [
    `id: ${c.id}`,
    `title: ${c.title}`,
    `url: ${c.url}`,
    `idleMinutes: ${c.idleMinutes}`,
    `reasons: ${c.reasons.join(', ')}`,
  ].join('\n')).join('\n\n')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model || 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `你是浏览器标签清理助手。你会收到一批候选标签及候选原因，请判断每个标签是否适合关闭。\n\n规则：\n1. 只有重复页面、空白新标签页、明显无继续阅读价值且长时间未访问的页面，才建议 close。\n2. 文档、工作台、代码、邮件、聊天、正在进行的任务页面，倾向 keep。\n3. 不确定就输出 unsure，不要冒险建议关闭。\n4. 为了避免输出过长，只输出 decision 为 close 或 unsure 的标签；建议保留的标签不要输出。\n5. 严格输出 JSON，不要输出 Markdown 代码块或其他内容。\n\n输出示例：\n{"items":[{"tabId":123,"decision":"close","reason":"重复 URL，可以关闭重复项"},{"tabId":456,"decision":"unsure","reason":"文档页面，无法判断是否仍需要"}]}`,
          },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errText = await response.text()
      return { data: null, error: `API 返回 ${response.status}: ${errText.slice(0, 100)}` }
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return { data: null, error: 'AI 返回空内容' }

    const parsed = parseJsonContent(content) as { items?: CleanupDecision[] }
    const ids = new Set(limitedCandidates.map(c => c.id))
    const decisions = (parsed.items ?? [])
      .filter(item => ids.has(item.tabId))
      .map(item => ({
        tabId: item.tabId,
        decision: item.decision === 'close' || item.decision === 'keep' || item.decision === 'unsure' ? item.decision : 'unsure',
        reason: item.reason || 'AI 未提供理由',
      }))

    return { data: decisions }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { data: null, error: 'AI 请求超时 (30s)' }
    if (err instanceof SyntaxError) return { data: null, error: `AI 返回格式异常: ${err.message}` }
    return { data: null, error: `网络错误: ${(err as Error).message}` }
  }
}

function mapCachedResult(
  result: Array<{ title: string; color: string; urls: string[] }>,
  tabs: Array<{ index: number; title: string; url: string }>,
): AIGroupResponse {
  const urlToIndex = new Map(tabs.map(t => [t.url, t.index]))
  return {
    groups: result.map(g => ({
      title: g.title,
      color: g.color,
      indices: g.urls.map(u => urlToIndex.get(u)).filter((i): i is number => i !== undefined),
    })),
  }
}

// Fallback: group by domain
export function groupTabsByDomain(
  tabs: Array<{ index: number; title: string; url: string }>,
): AIGroupResponse {
  const domainMap = new Map<string, number[]>()
  tabs.forEach(t => {
    try {
      const domain = new URL(t.url).hostname || 'other'
      if (!domainMap.has(domain)) domainMap.set(domain, [])
      domainMap.get(domain)!.push(t.index)
    } catch {
      if (!domainMap.has('other')) domainMap.set('other', [])
      domainMap.get('other')!.push(t.index)
    }
  })

  const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
  const groups = Array.from(domainMap.entries()).map(([domain, indices], i) => ({
    title: domain,
    color: colors[i % colors.length],
    indices,
  }))

  return { groups }
}
