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
