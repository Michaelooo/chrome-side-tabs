import { Fragment } from 'react'

/**
 * 极简 Markdown 渲染。只支持模型实际会用到的子集，
 * 全程构造 React 元素、不碰 innerHTML，所以没有 XSS 面。
 */

type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'hr' }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) { i++; continue }

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: buf.join('\n') })
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    // 普通段落：连续非空行合成一段
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*([-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>|```)/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    blocks.push({ type: 'p', text: buf.join('\n') })
  }

  return blocks
}

// 行内标记：代码、链接、裸链接、粗体、斜体
const INLINE_RE = /(`[^`]+`)|(\[[^\]]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()[\]，。、！？]+)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const tail = u.pathname === '/' ? '' : u.pathname
    const full = u.hostname + tail
    return full.length > 42 ? full.slice(0, 40) + '…' : full
  } catch {
    return url
  }
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      style={{ color: '#818cf8', textDecoration: 'underline', textUnderlineOffset: 2, wordBreak: 'break-all' }}
    >
      {children}
    </a>
  )
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  INLINE_RE.lastIndex = 0

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyPrefix}-${n++}`
    const token = m[0]

    if (m[1]) {
      out.push(
        <code
          key={key}
          style={{
            padding: '1px 4px', borderRadius: 3, fontSize: '0.92em',
            background: 'var(--t-bg)', fontFamily: 'Menlo, Consolas, monospace',
          }}
        >
          {token.slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      // [文字](链接) —— 链接文字之外，把原始地址也带上，方便直接复制
      const match = token.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/)!
      const [, label, href] = match
      out.push(
        <Fragment key={key}>
          <Link href={href}>{label || shortUrl(href)}</Link>
          {label && (
            <span style={{ color: 'var(--t-text-faint)', fontSize: '0.88em' }}> （{shortUrl(href)}）</span>
          )}
        </Fragment>,
      )
    } else if (m[3]) {
      out.push(<Link key={key} href={token}>{shortUrl(token)}</Link>)
    } else if (m[4] || m[5]) {
      out.push(<strong key={key} style={{ fontWeight: 600 }}>{token.slice(2, -2)}</strong>)
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>)
    }

    last = m.index + token.length
  }

  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text, color }: { text: string; color?: string }) {
  const blocks = parseBlocks(text)

  return (
    <div className="text-[11px] leading-relaxed" style={{ color: color ?? 'var(--t-text)' }}>
      {blocks.map((block, bi) => {
        switch (block.type) {
          case 'h':
            return (
              <div
                key={bi}
                style={{
                  fontWeight: 600,
                  fontSize: block.level <= 2 ? '1.15em' : '1.05em',
                  margin: bi === 0 ? '0 0 4px' : '8px 0 4px',
                }}
              >
                {renderInline(block.text, `h${bi}`)}
              </div>
            )

          case 'ul':
            return (
              <ul key={bi} style={{ margin: '4px 0', paddingLeft: 16, listStyle: 'disc' }}>
                {block.items.map((item, ii) => (
                  <li key={ii} style={{ margin: '2px 0' }}>{renderInline(item, `ul${bi}-${ii}`)}</li>
                ))}
              </ul>
            )

          case 'ol':
            return (
              <ol key={bi} style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'decimal' }}>
                {block.items.map((item, ii) => (
                  <li key={ii} style={{ margin: '2px 0' }}>{renderInline(item, `ol${bi}-${ii}`)}</li>
                ))}
              </ol>
            )

          case 'quote':
            return (
              <div
                key={bi}
                style={{
                  margin: '6px 0', padding: '4px 8px',
                  borderLeft: '2px solid var(--t-border)',
                  color: 'var(--t-text-muted)',
                }}
              >
                {renderInline(block.text, `q${bi}`)}
              </div>
            )

          case 'code':
            return (
              <pre
                key={bi}
                style={{
                  margin: '6px 0', padding: '6px 8px', borderRadius: 4,
                  background: 'var(--t-bg)', overflowX: 'auto',
                  fontSize: '0.92em', fontFamily: 'Menlo, Consolas, monospace',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}
              >
                {block.text}
              </pre>
            )

          case 'hr':
            return <div key={bi} style={{ height: 1, background: 'var(--t-border)', margin: '8px 0' }} />

          default:
            return (
              <p key={bi} style={{ margin: bi === 0 ? '0' : '6px 0 0', whiteSpace: 'pre-wrap' }}>
                {renderInline(block.text, `p${bi}`)}
              </p>
            )
        }
      })}
    </div>
  )
}
