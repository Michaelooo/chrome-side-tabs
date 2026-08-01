import { useState, useEffect, useRef } from 'react'
import { storage } from '../lib/storage'
import { SYSTEM_PROMPT } from '../lib/ai-client'
import { PERMISSION_LABEL, PERMISSION_REASON } from '../lib/permissions'
import type { OptionalPermission } from '../lib/permissions'
import { exportBackup, downloadBackup, importBackup } from '../lib/backup'
import type { AppConfig, GroupingRule, GroupColor } from '../types/entities'

const OPTIONAL_PERMISSIONS: OptionalPermission[] = ['history', 'bookmarks', 'sessions']

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
    if (partial.stash) next.stash = { ...current.stash, ...partial.stash }
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

          <div style={css.field}>
            <span style={css.label}>分组规则</span>
            <span style={css.hint}>
              命中规则的标签直接归组，完全不会发给 AI——既省 token，结果也确定。
              支持 <code style={css.code}>*</code> 通配，匹配网址或标题。
            </span>
            <RulesEditor
              rules={config.grouping.rules ?? []}
              onChange={rules => save({ grouping: { ...config.grouping, rules } })}
            />
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

      {/* Stash */}
      <section style={css.section}>
        <h2 style={css.sectionTitle}>归档</h2>
        <div style={css.card}>
          <label style={css.field}>
            <span style={css.label}>自动归档长期不用的标签</span>
            <Switch checked={config.stash.autoEnabled} onChange={v => save({ stash: { ...config.stash, autoEnabled: v } })} />
          </label>
          <span style={css.hint}>
            休眠只省内存，归档才省注意力。开启后，超过下面天数没访问的标签会被自动收进归档抽屉并关闭，
            随时可以在侧栏底部的归档里一键恢复。固定、正在播放声音和当前标签不会被归档。
          </span>
          {config.stash.autoEnabled && (
            <div style={css.field}>
              <div style={css.sliderRow}>
                <span style={css.label}>闲置天数</span>
                <span style={css.sliderValue}>{config.stash.autoDays} 天</span>
              </div>
              <input
                type="range"
                value={config.stash.autoDays}
                onChange={e => save({ stash: { ...config.stash, autoDays: Number(e.target.value) } })}
                min={1}
                max={30}
                style={css.slider}
              />
            </div>
          )}
        </div>
      </section>

      <PermissionsSection />
      <BackupSection />

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

async function readGranted(): Promise<Set<OptionalPermission>> {
  const next = new Set<OptionalPermission>()
  for (const p of OPTIONAL_PERMISSIONS) {
    if (await chrome.permissions.contains({ permissions: [p] })) next.add(p)
  }
  return next
}

// --- 可选权限 ---
// 授权和收回都不影响任何存储，随时可以来回切，不需要卸载重装扩展。
function PermissionsSection() {
  const [granted, setGranted] = useState<Set<OptionalPermission>>(new Set())

  useEffect(() => {
    let cancelled = false
    readGranted().then(next => { if (!cancelled) setGranted(next) })
    return () => { cancelled = true }
  }, [])

  // request / remove 都必须在用户手势里调用
  async function toggle(p: OptionalPermission, on: boolean) {
    if (on) await chrome.permissions.request({ permissions: [p] })
    else await chrome.permissions.remove({ permissions: [p] })
    setGranted(await readGranted())
  }

  return (
    <section style={css.section}>
      <h2 style={css.sectionTitle}>可选权限</h2>
      <div style={css.card}>
        <span style={css.hint}>
          这些权限安装时不会索取，只有用到对应功能时才申请。授权一次长期有效，
          在这里随时可以收回——<strong>收回和重新授权都不会动你的任何配置和数据</strong>。
        </span>
        {OPTIONAL_PERMISSIONS.map(p => (
          <label key={p} style={css.field}>
            <div style={css.sliderRow}>
              <span style={css.label}>{PERMISSION_LABEL[p]}</span>
              <Switch checked={granted.has(p)} onChange={v => toggle(p, v)} />
            </div>
            <span style={css.hint}>{PERMISSION_REASON[p]}</span>
          </label>
        ))}
      </div>
    </section>
  )
}

// --- 备份与恢复 ---
function BackupSection() {
  const [includeKey, setIncludeKey] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function doExport() {
    downloadBackup(await exportBackup(includeKey))
    setStatus('已导出备份文件')
  }

  async function doImport(file: File) {
    try {
      const result = await importBackup(JSON.parse(await file.text()))
      const parts = []
      if (result.restored.length) parts.push(`已恢复：${result.restored.join('、')}`)
      if (result.skipped.length) parts.push(`跳过：${result.skipped.join('、')}`)
      setStatus(parts.join('；') || '备份文件里没有可恢复的内容')
    } catch (err) {
      setStatus(`导入失败：${(err as Error).message}`)
    }
  }

  return (
    <section style={css.section}>
      <h2 style={css.sectionTitle}>备份与恢复</h2>
      <div style={css.card}>
        <span style={css.hint}>
          扩展的所有数据都存在浏览器本地。<strong>移除扩展会一并清空这些数据</strong>，
          换设备或重装前先导出一份。导入采用合并策略，归档和会话按去重追加，不会冲掉现有内容。
        </span>

        <label style={css.field}>
          <div style={css.sliderRow}>
            <span style={css.label}>备份里包含 API Key</span>
            <Switch checked={includeKey} onChange={setIncludeKey} />
          </div>
          <span style={css.hint}>
            关闭时导出的文件不含密钥，适合传输；开启则是完整备份，请自己保管好文件。
          </span>
        </label>

        <div style={{ display: 'flex', gap: 8 }}>
          <button style={css.ruleAdd} onClick={doExport}>导出备份</button>
          <button
            style={{ ...css.ruleAdd, background: '#fff', color: '#444', border: '1px solid #d9d9d9' }}
            onClick={() => fileRef.current?.click()}
          >
            导入备份
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) doImport(file)
              e.target.value = ''
            }}
          />
        </div>

        {status && <span style={{ ...css.hint, color: '#22c55e' }}>{status}</span>}
      </div>
    </section>
  )
}

// --- 分组规则编辑器 ---
function RulesEditor({ rules, onChange }: {
  rules: GroupingRule[]
  onChange: (rules: GroupingRule[]) => void
}) {
  const [pattern, setPattern] = useState('')
  const [title, setTitle] = useState('')

  function add() {
    if (!pattern.trim() || !title.trim()) return
    onChange([...rules, {
      id: `rule-${Date.now()}`,
      pattern: pattern.trim(),
      title: title.trim(),
      color: RULE_COLORS[rules.length % RULE_COLORS.length],
    }])
    setPattern('')
    setTitle('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      {rules.map(rule => (
        <div key={rule.id} style={css.ruleRow}>
          <code style={css.rulePattern}>{rule.pattern}</code>
          <span style={{ color: '#aaa', fontSize: 12 }}>→</span>
          <span style={{ fontSize: 13, flex: 1 }}>{rule.title}</span>
          <button
            style={css.ruleRemove}
            onClick={() => onChange(rules.filter(r => r.id !== rule.id))}
          >
            移除
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...css.input, flex: 2 }}
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder="*.github.com"
        />
        <input
          style={{ ...css.input, flex: 1 }}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder="组名"
        />
        <button style={css.ruleAdd} onClick={add}>添加</button>
      </div>
    </div>
  )
}

const RULE_COLORS: GroupColor[] = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red']

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
  ruleRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 10px', background: '#f7f7f7',
    border: '1px solid #eee', borderRadius: 6,
  },
  rulePattern: {
    padding: '2px 6px', background: '#fff', border: '1px solid #e5e5e5',
    borderRadius: 4, fontSize: 12, fontFamily: 'Menlo, monospace', color: '#555',
  },
  ruleRemove: {
    padding: '4px 8px', fontSize: 11, color: '#ef4444',
    background: 'transparent', border: 'none', cursor: 'pointer',
  },
  ruleAdd: {
    padding: '8px 14px', fontSize: 13, color: '#fff',
    background: '#22c55e', border: 'none', borderRadius: 6, cursor: 'pointer',
    flexShrink: 0,
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
