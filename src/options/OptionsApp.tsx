import { useState, useEffect } from 'react'
import { storage } from '../lib/storage'
import { SYSTEM_PROMPT } from '../lib/ai-client'
import type { AppConfig } from '../types/entities'

export function OptionsApp() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    storage.config.get().then(c => setConfig({ ...c }))
  }, [])

  async function save(partial: Partial<AppConfig>) {
    const current = config!
    const next = { ...current, ...partial }
    // Deep merge for ai object
    if (partial.ai) next.ai = { ...current.ai, ...partial.ai }
    if (partial.grouping) next.grouping = { ...current.grouping, ...partial.grouping }
    if (partial.suspend) next.suspend = { ...current.suspend, ...partial.suspend }
    setConfig(next)
    await storage.config.set(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  if (!config) return <div className="loading">加载中...</div>

  return (
    <div style={css.page}>
      {/* Header */}
      <header style={css.header}>
        <h1 style={css.headerTitle}>Side Tabs</h1>
        <p style={css.headerSub}>设置</p>
      </header>

      {/* AI Config */}
      <section style={css.section}>
        <h2 style={css.sectionTitle}>AI 智能分组</h2>
        <div style={css.card}>
          <label style={css.field}>
            <span style={css.label}>启用 AI 分组</span>
            <Switch checked={config.ai.enabled} onChange={v => save({ ai: { ...config.ai, enabled: v } })} />
          </label>

          {config.ai.enabled && (
            <div style={css.fieldGroup}>
              <div style={css.field}>
                <span style={css.label}>API 地址</span>
                <input
                  style={css.input}
                  value={config.ai.baseURL}
                  onChange={e => save({ ai: { ...config.ai, baseURL: e.target.value } })}
                  placeholder="https://api.deepseek.com"
                />
                <span style={css.hint}>OpenAI 兼容端点，无需带 /v1 路径</span>
              </div>
              <div style={css.field}>
                <span style={css.label}>API Key</span>
                <input
                  style={css.input}
                  type="password"
                  value={config.ai.apiKey}
                  onChange={e => save({ ai: { ...config.ai, apiKey: e.target.value } })}
                  placeholder="sk-..."
                />
                <span style={css.hint}>仅存储在本地 chrome.storage.local</span>
              </div>
              <div style={css.field}>
                <span style={css.label}>模型</span>
                <input
                  style={css.input}
                  value={config.ai.model}
                  onChange={e => save({ ai: { ...config.ai, model: e.target.value } })}
                  placeholder="deepseek-chat"
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Prompt Config */}
      <section style={css.section}>
        <h2 style={css.sectionTitle}>分组提示词</h2>
        <div style={css.card}>
          <div style={css.field}>
            <span style={css.label}>系统提示词</span>
            <pre style={css.promptDisplay}>{SYSTEM_PROMPT}</pre>
            <span style={css.hint}>系统内置，不可修改</span>
          </div>
          <div style={css.field}>
            <span style={css.label}>自定义提示词</span>
            <textarea
              style={css.textarea}
              value={config.ai.customPrompt}
              onChange={e => save({ ai: { ...config.ai, customPrompt: e.target.value } })}
              placeholder={'补充你的个性化要求，例如：\n- 所有社交媒体类的标签统一归为一组\n- 工作相关的标签优先分为「开发」「文档」「沟通」三组\n- 如果有在线文档或表格，归到「协作文档」组'}
              rows={5}
            />
            <span style={css.hint}>可选。会追加在系统提示词之后，用于个性化分组规则</span>
          </div>
        </div>
      </section>

      {/* Grouping Threshold */}
      <section style={css.section}>
        <h2 style={css.sectionTitle}>分组设置</h2>
        <div style={css.card}>
          <div style={css.field}>
            <div style={css.sliderRow}>
              <span style={css.label}>自动分组阈值</span>
              <span style={css.sliderValue}>{config.grouping.autoThreshold} 个标签</span>
            </div>
            <input
              type="range"
              value={config.grouping.autoThreshold}
              onChange={e => save({ grouping: { ...config.grouping, autoThreshold: Number(e.target.value) } })}
              min={3}
              max={50}
              style={css.slider}
            />
            <span style={css.hint}>未分组标签数达到此值时自动触发 AI 分组</span>
          </div>
        </div>
      </section>

      {/* Suspend */}
      <section style={css.section}>
        <h2 style={css.sectionTitle}>标签休眠</h2>
        <div style={css.card}>
          <label style={css.field}>
            <span style={css.label}>启用自动休眠</span>
            <Switch checked={config.suspend.enabled} onChange={v => save({ suspend: { ...config.suspend, enabled: v } })} />
          </label>
          {config.suspend.enabled && (
            <div style={css.field}>
              <div style={css.sliderRow}>
                <span style={css.label}>空闲时间</span>
                <span style={css.sliderValue}>{config.suspend.idleMinutes} 分钟</span>
              </div>
              <input
                type="range"
                value={config.suspend.idleMinutes}
                onChange={e => save({ suspend: { ...config.suspend, idleMinutes: Number(e.target.value) } })}
                min={5}
                max={120}
                step={5}
                style={css.slider}
              />
            </div>
          )}
        </div>
      </section>

      {/* Tip */}
      <section style={css.section}>
        <div style={css.tip}>
          <strong>侧边栏位置</strong>
          <p>前往 <code style={css.code}>chrome://settings/appearance</code>，找到"侧边栏"选项，选择"在左侧显示"。</p>
        </div>
      </section>

      {/* Save indicator */}
      <div style={{ ...css.toast, opacity: saved ? 1 : 0, transform: saved ? 'translateY(0)' : 'translateY(8px)' }}>
        已保存
      </div>
    </div>
  )
}

// --- Switch component ---
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 36, height: 20, borderRadius: 10,
        backgroundColor: checked ? '#22c55e' : '#d1d5db',
        position: 'relative', cursor: 'pointer', transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: 8,
        backgroundColor: '#fff', transition: 'left 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }} />
    </div>
  )
}

// --- Styles (neutral gray palette, no purple) ---
const css: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 720, margin: '0 auto', padding: '40px 32px 64px',
    minHeight: '100vh', background: '#fafafa', color: '#1a1a1a',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  header: {
    marginBottom: 32,
  },
  headerTitle: {
    fontSize: 22, fontWeight: 700, margin: 0, color: '#111',
  },
  headerSub: {
    fontSize: 13, color: '#888', margin: '4px 0 0',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14, fontWeight: 600, color: '#333', margin: '0 0 8px',
    paddingBottom: 6,
    borderBottom: '1px solid #e5e5e5',
  },
  card: {
    background: '#fff', border: '1px solid #e5e5e5', borderRadius: 8,
    padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16,
  },
  field: {
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  fieldGroup: {
    display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12,
    paddingTop: 12, borderTop: '1px solid #f0f0f0',
  },
  label: {
    fontSize: 13, fontWeight: 500, color: '#444',
  },
  input: {
    width: '100%', padding: '8px 12px', fontSize: 13,
    border: '1px solid #d9d9d9', borderRadius: 6,
    background: '#fff', color: '#1a1a1a',
    outline: 'none',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%', padding: '8px 12px', fontSize: 13,
    border: '1px solid #d9d9d9', borderRadius: 6,
    background: '#fff', color: '#1a1a1a',
    outline: 'none', resize: 'vertical', fontFamily: 'inherit',
    lineHeight: 1.5, boxSizing: 'border-box',
  },
  hint: {
    fontSize: 11, color: '#aaa',
  },
  promptDisplay: {
    fontSize: 12, lineHeight: 1.6,
    padding: '10px 12px', margin: 0,
    background: '#f7f7f7', border: '1px solid #eee',
    borderRadius: 6, color: '#666',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 200, overflowY: 'auto',
  },
  sliderRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  sliderValue: {
    fontSize: 13, color: '#888', fontWeight: 500, fontVariantNumeric: 'tabular-nums',
  },
  slider: {
    width: '100%', accentColor: '#22c55e',
  },
  tip: {
    padding: '12px 16px', background: '#fff', border: '1px solid #e5e5e5',
    borderRadius: 8, fontSize: 13, color: '#555',
  },
  code: {
    padding: '2px 6px', background: '#f0f0f0', borderRadius: 4,
    fontSize: 12, fontFamily: 'Menlo, monospace',
  },
  toast: {
    position: 'fixed', bottom: 20, right: 20,
    padding: '8px 16px', borderRadius: 6,
    background: '#22c55e', color: '#fff',
    fontSize: 13, fontWeight: 500,
    transition: 'all 0.2s',
    pointerEvents: 'none',
  },
}
