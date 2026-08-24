'use client'

import { Fragment, type ReactNode } from 'react'

/**
 * Minimal markdown renderer for plugin READMEs — headings, fenced code,
 * inline code, bold, links, lists, tables-as-code, paragraphs. Built as
 * React nodes (never innerHTML), so plugin-supplied text cannot inject
 * markup. Anything fancier than a README warrants a real parser; this is
 * deliberately not one.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  // split on `code`, **bold**, [label](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyBase}-${i++}`
    if (token.startsWith('`')) {
      out.push(<code key={key} className="px-1 rounded text-[0.85em]" style={{ background: 'color-mix(in srgb, var(--border) 40%, transparent)' }}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      const label = token.slice(1, token.indexOf(']'))
      out.push(<a key={key} href={m[4]} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>{label}</a>)
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!)
      i++
      blocks.push(
        <pre key={key++} className="rounded-md p-3 text-xs overflow-x-auto font-mono" style={{ background: 'color-mix(in srgb, var(--border) 30%, transparent)' }}>
          {code.join('\n')}
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const sizes = ['text-lg font-semibold', 'text-base font-semibold', 'text-sm font-semibold', 'text-sm font-medium']
      blocks.push(<div key={key++} className={`${sizes[level - 1]} mt-3`}>{inline(heading[2]!, `h${key}`)}</div>)
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''))
      blocks.push(
        <ul key={key++} className="list-disc pl-5 flex flex-col gap-0.5">
          {items.map((item, j) => <li key={j}>{inline(item, `li${key}-${j}`)}</li>)}
        </ul>,
      )
      continue
    }
    if (line.trim() === '') { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('```') && !/^(#{1,4})\s/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!)) {
      para.push(lines[i++]!)
    }
    blocks.push(<p key={key++}>{inline(para.join(' '), `p${key}`)}</p>)
  }
  return <div className="flex flex-col gap-2 text-sm leading-relaxed" style={{ color: 'var(--foreground)' }}>{blocks.map((b, j) => <Fragment key={j}>{b}</Fragment>)}</div>
}
