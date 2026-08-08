import { useState, useEffect, useRef } from 'react'
import { storage } from '../lib/storage'
import { SYSTEM_PROMPT } from '../lib/ai-client'
import { PERMISSION_LABEL, PERMISSION_REASON } from '../lib/permissions'
import type { OptionalPermission } from '../lib/permissions'
import { exportBackup, downloadBackup, importBackup } from '../lib/backup'
import { setMode } from '../lib/mode'
import type { AppConfig, GroupingRule, GroupColor, UIMode } from '../types/entities'

const OPTIONAL_PERMISSIONS: OptionalPermission[] = ['history', 'bookmarks', 'sessions']

type SectionId = 'appearance' | 'ai' | 'grouping' | 'automation' | 'data'

const ICON = {
  appearance: <path d="M3 4h18v16H3zM9 4v16" />,
  ai: <><path d="M9.5 2l.6 4.4 4.4.6-4.4.6-.6 4.4-.6-4.4L4.5 7l4.4-.6z" /><path d="M17.5 13l.4 2.6 2.6.4-2.6.4-.4 2.6-.4-2.6-2.6-.4 2.6-.4z" /></>,
  grouping: <><path d="M4 6h7v5H4zM13 6h7v5h-7zM4 13h7v5H4zM13 13h7v5h-7z" /></>,
  automation: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  data: <><path d="M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
}

const SECTIONS: Array<{ id: SectionId; label: string; desc: string; icon: React.ReactNode }> = [
  { id: 'appearance', label: '界面', desc: '侧边栏还是页面浮球', icon: ICON.appearance },
  { id: 'ai', label: 'AI 服务', desc: 'API 端点、密钥与模型', icon: ICON.ai },
  { id: 'grouping', label: '分组', desc: '规则、提示词与分组行为', icon: ICON.grouping },
  { id: 'automation', label: '自动整理', desc: '休眠与自动归档', icon: ICON.automation },
  { id: 'data', label: '权限与数据', desc: '可选权限、备份与恢复', icon: ICON.data },
]

const HASH_TO_SECTION: Record<string, SectionId> = {
  '#appearance': 'appearance',
  '#ai': 'ai',
  '#grouping': 'grouping',
  '#automation': 'automation',
  '#data': 'data',
}

function sectionFromHash(): SectionId {
  return HASH_TO_SECTION[window.location.hash] ?? 'appearance'
}

export function OptionsApp() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [section, setSection] = useState<SectionId>(sectionFromHash)

  useEffect(() => {
    storage.config.get().then(c => setConfig({ ...c }))
  }, [])

  // 走 hash 而不是纯 state：设置项可以被直接链接过来（比如助手提示"去设置页填 API"）
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
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
    flashSaved()
  }

  // 形态切换要连带改浏览器状态（侧栏开关）并通知已打开的页面，走 setMode 而非通用 save
  async function changeMode(mode: UIMode) {
    setConfig({ ...config!, ui: { ...config!.ui, mode } })
    await setMode(mode)
    flashSaved()
  }

  function flashSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  if (!config) return <div className="loading">加载中...</div>

  const current = SECTIONS.find(s => s.id === section) ?? SECTIONS[0]

  return (
    <div style={css.page}>
      <header style={css.header}>
        <h1 style={css.headerTitle}>Side Tabs</h1>
        <p style={css.headerSub}>设置</p>
      </header>

      <div style={css.layout}>
        <nav style={css.nav}>
          {SECTIONS.map(s => (
            <NavItem
              key={s.id}
              active={s.id === section}
              onClick={() => { window.location.hash = `#${s.id}`; setSection(s.id) }}
              label={s.label}
              desc={s.desc}
              icon={s.icon}
            />
          ))}
        </nav>

        <div style={css.pane}>
          <div style={css.paneHead}>
            <h2 style={css.paneTitle}>{current.label}</h2>
            <p style={css.paneDesc}>{current.desc}</p>
          </div>

          {section === 'appearance' && (
            <>
              <Block title="形态">
                <div style={css.modeGrid}>
                  <ModeCard
                    active={config.ui.mode === 'sidepanel'}
                    onClick={() => changeMode('sidepanel')}
                    name="侧边栏"
                    desc="扩展侧栏显示完整标签列表、分组、来源链路。配合传统的水平标签栏使用。"
                  />
                  <ModeCard
                    active={config.ui.mode === 'orb'}
                    onClick={() => changeMode('orb')}
                    name="页面浮球"
                    desc="侧栏关闭，改由网页左下角浮球提供 AI 整理、清理、归档和对话。标签列表交给 Chrome 原生垂直标签栏。"
                  />
                </div>
                <span style={css.hint}>
                  {config.ui.mode === 'orb'
                    ? '把手在 chrome:// 页、Chrome 应用商店、PDF 阅读器上不会出现（浏览器不允许注入）——在这些页面按快捷键或点工具栏图标会打开独立面板。'
                    : 'Chrome 145+ 支持原生垂直标签栏：右键标签栏选「以垂直方式显示标签页」。开了之后建议切到「页面浮球」，避免两份标签列表并存。'}
                </span>
              </Block>

              {config.ui.mode === 'orb' && (
                <Block title="三个入口" desc="面板不常驻，靠召唤。这三条路各管一段。">
                  <ShortcutField />
                  <div style={css.field}>
                    <span style={css.label}>工具栏图标徽标</span>
                    <span style={css.hint}>
                      未分组标签攒到 8 个以上，Chrome 工具栏上的 Side Tabs 图标右下角会出现一个数字角标
                      （像 App 图标上的未读数）。点图标即从左边滑出面板。平时不显示——它是行动信号，不是常年挂着的计数器。
                      <strong>前提是扩展图标已固定在工具栏上</strong>，收在拼图菜单里就看不见了。
                    </span>
                  </div>
                  <div style={css.field}>
                    <span style={css.label}>页面左边缘把手</span>
                    <span style={css.hint}>
                      视口左边缘中部一块深色片，划过去会变宽。放在中部而不是左下角，是因为左下角是
                      cookie 横幅和客服气泡的地盘，那儿有横幅盲区。
                    </span>
                  </div>
                </Block>
              )}

              {config.ui.mode === 'sidepanel' && (
                <Block title="侧边栏位置">
                  <span style={css.hint}>
                    前往 <code style={css.code}>chrome://settings/appearance</code>，找到「侧边栏」选项，选择「在左侧显示」。
                  </span>
                </Block>
              )}
            </>
          )}

          {section === 'ai' && (
            <Block
              title="AI 端点"
              desc="AI 分组、智能清理和标签助手都走这一份配置。数据只发往你自己填的端点。"
            >
              <label style={css.field}>
                <div style={css.sliderRow}>
                  <span style={css.label}>启用 AI</span>
                  <Switch checked={config.ai.enabled} onChange={v => save({ ai: { ...config.ai, enabled: v } })} />
                </div>
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
            </Block>
          )}

          {section === 'grouping' && (
            <>
              <Block
                title="分组规则"
                desc="命中规则的标签直接归组，完全不会发给 AI——既省 token，结果也确定。"
              >
                <span style={css.hint}>
                  支持 <code style={css.code}>*</code> 通配，匹配网址或标题。
                </span>
                <RulesEditor
                  rules={config.grouping.rules ?? []}
                  onChange={rules => save({ grouping: { ...config.grouping, rules } })}
                />
              </Block>

              <Block title="自定义提示词" desc="追加在内置提示词之后，用于个性化分组口味。">
                <textarea
                  style={css.textarea}
                  value={config.ai.customPrompt}
                  onChange={e => save({ ai: { ...config.ai, customPrompt: e.target.value } })}
                  placeholder={'例如：\n- 所有社交媒体类的标签统一归为一组\n- 工作相关的标签优先分为「开发」「文档」「沟通」三组\n- 如果有在线文档或表格，归到「协作文档」组'}
                  rows={5}
                />
                {/* 内置提示词是只读参考，平时不该占掉半屏 */}
                <details style={css.details}>
                  <summary style={css.summary}>查看内置系统提示词（不可修改）</summary>
                  <pre style={css.promptDisplay}>{SYSTEM_PROMPT}</pre>
                </details>
              </Block>
            </>
          )}

          {section === 'automation' && (
            <>
              <Block title="标签休眠" desc="释放内存，标签还在，点回去会重新加载。">
                <label style={css.field}>
                  <div style={css.sliderRow}>
                    <span style={css.label}>启用自动休眠</span>
                    <Switch checked={config.suspend.enabled} onChange={v => save({ suspend: { ...config.suspend, enabled: v } })} />
                  </div>
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
              </Block>

              <Block title="自动归档" desc="休眠只省内存，归档才省注意力。">
                <label style={css.field}>
                  <div style={css.sliderRow}>
                    <span style={css.label}>自动归档长期不用的标签</span>
                    <Switch checked={config.stash.autoEnabled} onChange={v => save({ stash: { ...config.stash, autoEnabled: v } })} />
                  </div>
                </label>
                <span style={css.hint}>
                  开启后，超过下面天数没访问的标签会被自动收进归档抽屉并关闭，随时可以在侧栏底部的归档里一键恢复。
                  固定、正在播放声音和当前标签不会被归档。
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
              </Block>
            </>
          )}

          {section === 'data' && (
            <>
              <PermissionsSection />
              <BackupSection />
            </>
          )}
        </div>
      </div>

      {/* Save indicator */}
      <div style={{ ...css.toast, opacity: saved ? 1 : 0, transform: saved ? 'translateY(0)' : 'translateY(8px)' }}>
        已保存
      </div>
    </div>
  )
}

function NavItem({ active, onClick, label, desc, icon }: {
  active: boolean
  onClick: () => void
  label: string
  desc: string
  icon: React.ReactNode
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...css.navItem,
        background: active ? '#eef0ff' : hover ? '#f2f2f2' : 'transparent',
        color: active ? '#4f46e5' : '#555',
      }}
    >
      <svg
        width="17" height="17" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
        style={{ marginTop: 1, flexShrink: 0 }}
      >
        {icon}
      </svg>
      <span style={{ minWidth: 0 }}>
        <span style={{ ...css.navLabel, color: active ? '#4f46e5' : '#333' }}>{label}</span>
        <span style={css.navDesc}>{desc}</span>
      </span>
    </button>
  )
}

/**
 * 快捷键不写死在界面上：用户可能改过，Chrome 也会在建议键冲突时静默丢弃它。
 * 只有 commands.getAll() 说的才算数。
 */
function ShortcutField() {
  const [shortcut, setShortcut] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    chrome.commands.getAll().then(cmds => {
      if (cancelled) return
      setShortcut(cmds.find(c => c.name === 'toggle-panel')?.shortcut || '')
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={css.field}>
      <span style={css.label}>
        快捷键{' '}
        {shortcut
          ? <code style={css.code}>{shortcut}</code>
          : shortcut === '' ? <span style={{ color: '#ef4444', fontWeight: 400 }}>未绑定</span> : null}
      </span>
      <span style={css.hint}>
        {shortcut === ''
          ? '建议键可能与其他快捷键冲突被浏览器丢弃了，'
          : '任意页面按下即出，面板居中弹出。要改的话，'}
        去{' '}
        <a
          href="#"
          style={css.link}
          onClick={e => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }}
        >
          chrome://extensions/shortcuts
        </a>{' '}
        设置。macOS 上 Chrome 的 <code style={css.code}>Alt</code> 就是 Option 键。
      </span>
    </div>
  )
}

/** 一个分组内的子块。分类之后每段里往往还有两三件事，需要一层标题把它们分开 */
function Block({ title, desc, children }: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div style={css.block}>
      <h3 style={css.blockTitle}>{title}</h3>
      {desc && <p style={css.blockDesc}>{desc}</p>}
      <div style={css.card}>{children}</div>
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
    <Block
      title="可选权限"
      desc="安装时不索取，用到对应功能才申请。收回和重新授权都不会动你的任何配置和数据。"
    >
      {OPTIONAL_PERMISSIONS.map(p => (
        <label key={p} style={css.field}>
          <div style={css.sliderRow}>
            <span style={css.label}>{PERMISSION_LABEL[p]}</span>
            <Switch checked={granted.has(p)} onChange={v => toggle(p, v)} />
          </div>
          <span style={css.hint}>{PERMISSION_REASON[p]}</span>
        </label>
      ))}
    </Block>
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
    <Block
      title="备份与恢复"
      desc="所有数据都存在浏览器本地，移除扩展会一并清空。换设备或重装前先导出一份。"
    >
      <span style={css.hint}>
        导入采用合并策略，归档和会话按去重追加，不会冲掉现有内容。
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
    </Block>
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

function ModeCard({ active, onClick, name, desc }: {
  active: boolean
  onClick: () => void
  name: string
  desc: string
}) {
  return (
    <div
      onClick={onClick}
      style={{
        ...css.modeCard,
        borderColor: active ? '#6366f1' : '#e5e5e5',
        background: active ? '#f5f5ff' : '#fff',
      }}
    >
      <div style={css.modeHead}>
        <span style={{ ...css.modeName, color: active ? '#4f46e5' : '#444' }}>{name}</span>
        {active && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </div>
      <span style={css.modeDesc}>{desc}</span>
    </div>
  )
}

// --- Styles (neutral gray palette, no purple) ---
const css: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 960, margin: '0 auto', padding: '40px 32px 64px',
    minHeight: '100vh', background: '#fafafa', color: '#1a1a1a',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  header: {
    marginBottom: 28,
  },
  headerTitle: {
    fontSize: 22, fontWeight: 700, margin: 0, color: '#111',
  },
  headerSub: {
    fontSize: 13, color: '#888', margin: '4px 0 0',
  },
  layout: {
    display: 'grid', gridTemplateColumns: '208px minmax(0, 1fr)', gap: 24,
    alignItems: 'start',
  },
  nav: {
    position: 'sticky', top: 24,
    display: 'flex', flexDirection: 'column', gap: 2,
    background: '#fff', border: '1px solid #e5e5e5', borderRadius: 10, padding: 6,
  },
  navItem: {
    display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
    padding: '9px 10px', borderRadius: 7, border: 'none',
    textAlign: 'left', cursor: 'pointer',
    transition: 'background 0.12s, color 0.12s',
    fontFamily: 'inherit',
  },
  navLabel: {
    display: 'block', fontSize: 13, fontWeight: 500,
  },
  navDesc: {
    display: 'block', marginTop: 2, fontSize: 11, lineHeight: 1.4, color: '#999',
  },
  pane: {
    minWidth: 0,
  },
  paneHead: {
    marginBottom: 20, paddingBottom: 12, borderBottom: '1px solid #e5e5e5',
  },
  paneTitle: {
    fontSize: 18, fontWeight: 600, color: '#111', margin: 0,
  },
  paneDesc: {
    fontSize: 12, color: '#999', margin: '4px 0 0',
  },
  block: {
    marginBottom: 24,
  },
  blockTitle: {
    fontSize: 13, fontWeight: 600, color: '#333', margin: '0 0 4px',
  },
  blockDesc: {
    fontSize: 11, color: '#aaa', margin: '0 0 8px', lineHeight: 1.6,
  },
  card: {
    background: '#fff', border: '1px solid #e5e5e5', borderRadius: 8,
    padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16,
  },
  field: {
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  fieldGroup: {
    display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4,
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
    fontSize: 11, color: '#aaa', lineHeight: 1.6,
  },
  details: {
    fontSize: 12,
  },
  summary: {
    fontSize: 11, color: '#888', cursor: 'pointer', userSelect: 'none',
    padding: '2px 0',
  },
  promptDisplay: {
    fontSize: 12, lineHeight: 1.6,
    padding: '10px 12px', margin: '8px 0 0',
    background: '#f7f7f7', border: '1px solid #eee',
    borderRadius: 6, color: '#666',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 260, overflowY: 'auto',
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
  code: {
    padding: '2px 6px', background: '#f0f0f0', borderRadius: 4,
    fontSize: 12, fontFamily: 'Menlo, monospace',
  },
  link: {
    color: '#6366f1', textDecoration: 'none',
  },
  modeGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
  },
  modeCard: {
    border: '1px solid #e5e5e5', borderRadius: 8, padding: '12px 14px',
    display: 'flex', flexDirection: 'column', gap: 6,
    cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s',
  },
  modeHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  },
  modeName: {
    fontSize: 13, fontWeight: 600,
  },
  modeDesc: {
    fontSize: 11, lineHeight: 1.6, color: '#888',
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
