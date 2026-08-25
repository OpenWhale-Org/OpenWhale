'use client'

import { useState, type ReactNode } from 'react'

/**
 * A JSON viewer with syntax colors and collapsible objects/arrays — the thing
 * a record modal needs that a <pre> can't give: fold the 678-entry `rates`
 * array, keep the three fields you're reading. Pure React, no highlighter
 * dependency; values are rendered as text nodes, never injected.
 *
 * Nodes deeper than `openDepth` start collapsed; a collapsed node shows its
 * size ("{3 keys}", "[678]") and a preview of primitive members.
 */

const COLORS = {
  key: 'var(--accent)',
  string: 'var(--success)',
  number: '#f6c85f',
  boolean: '#4d89ff',
  null: 'var(--muted)',
  punct: 'var(--muted)',
} as const

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span style={{ color: COLORS.null }}>null</span>
  switch (typeof value) {
    case 'string': return <span style={{ color: COLORS.string }}>&quot;{value}&quot;</span>
    case 'number': return <span style={{ color: COLORS.number }}>{String(value)}</span>
    case 'boolean': return <span style={{ color: COLORS.boolean }}>{String(value)}</span>
    case 'bigint': return <span style={{ color: COLORS.number }}>{value.toString()}n</span>
    case 'undefined': return <span style={{ color: COLORS.null }}>undefined</span>
    default: return <span>{String(value)}</span>
  }
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null
}

function preview(v: Record<string, unknown> | unknown[]): string {
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)
  const parts: string[] = []
  for (const [k, val] of entries.slice(0, 4)) {
    const shown = isContainer(val) ? (Array.isArray(val) ? `[${val.length}]` : '{…}') : typeof val === 'string' ? `"${val.length > 18 ? `${val.slice(0, 18)}…` : val}"` : String(val)
    parts.push(Array.isArray(v) ? shown : `${k}: ${shown}`)
  }
  if (entries.length > 4) parts.push('…')
  return parts.join(', ')
}

function Node({ name, value, depth, openDepth, last }: {
  name?: string
  value: unknown
  depth: number
  openDepth: number
  last: boolean
}) {
  const [open, setOpen] = useState(depth < openDepth)
  const comma = last ? null : <span style={{ color: COLORS.punct }}>,</span>
  const label = name !== undefined
    ? <><span style={{ color: COLORS.key }}>&quot;{name}&quot;</span><span style={{ color: COLORS.punct }}>: </span></>
    : null

  if (!isContainer(value)) {
    return <div style={{ paddingLeft: depth * 14 }}>{label}<Primitive value={value} />{comma}</div>
  }
  const isArr = Array.isArray(value)
  const entries: Array<[string, unknown]> = isArr ? value.map((x, i) => [String(i), x]) : Object.entries(value)
  const [openB, closeB] = isArr ? ['[', ']'] : ['{', '}']
  const size = isArr ? `${entries.length}` : `${entries.length} key${entries.length === 1 ? '' : 's'}`

  return (
    <div>
      <div style={{ paddingLeft: depth * 14 }} className="flex items-baseline gap-1">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="shrink-0 w-3 text-left"
          style={{ color: 'var(--muted)' }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="min-w-0 truncate">
          {label}
          <span style={{ color: COLORS.punct }}>{openB}</span>
          {!open && (
            <>
              <span className="mx-1 px-1 rounded text-[10px]" style={{ background: 'color-mix(in srgb, var(--border) 40%, transparent)', color: 'var(--muted)' }}>{size}</span>
              <span style={{ color: 'var(--muted)' }}>{preview(value)}</span>
              <span style={{ color: COLORS.punct }}>{closeB}</span>
              {comma}
            </>
          )}
        </span>
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <Node key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} openDepth={openDepth} last={i === entries.length - 1} />
          ))}
          <div style={{ paddingLeft: depth * 14 + 16 }}><span style={{ color: COLORS.punct }}>{closeB}</span>{comma}</div>
        </>
      )}
    </div>
  )
}

export function JsonTree({ data, openDepth = 2 }: { data: unknown; openDepth?: number }): ReactNode {
  return (
    <div className="font-mono text-xs leading-relaxed" style={{ color: 'var(--foreground)' }}>
      <Node value={data} depth={0} openDepth={openDepth} last />
    </div>
  )
}
