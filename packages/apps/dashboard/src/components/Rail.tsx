'use client'

import type { ReactNode } from 'react'

/**
 * The ONE side list. Every master-detail page (accounts, monitors, executors,
 * scripts, plugins, compiler sessions) and every picker dialog (strategy,
 * credential type) draws its left column from these three pieces:
 *
 *   <Rail>       the column — surface, border, optional header/search/footer,
 *                a body that scrolls without a visible track
 *   <RailGroup>  a section label (package, category) with a count, optionally
 *                collapsible
 *   <RailItem>   a row — mark | title + subtitle | right-hand meta —
 *                with one active treatment everywhere: accent tint + a 2px
 *                accent bar on the left. Multi-select rows swap the mark for
 *                a checkbox.
 *
 * Pages stopped inventing their own row (cards with full borders, bare
 * buttons, bordered pills) — the rail is now a vocabulary, not a style.
 */

export function Rail({ width = '18rem', header, search, footer, children, bare = false, className = '' }: {
  width?: string
  /** Fixed strip above the body (tabs, a total, a title row). */
  header?: ReactNode
  /** A search input, rendered in its own strip under the header. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }
  footer?: ReactNode
  children: ReactNode
  /** Inside a dialog: no outer surface/border/rounding, just the column. */
  bare?: boolean
  className?: string
}) {
  return (
    <div
      className={`flex flex-col min-h-0 shrink-0 ${bare ? '' : 'rounded-lg overflow-hidden'} ${className}`}
      style={{
        width,
        ...(bare
          ? { borderRight: '1px solid var(--border)' }
          : { background: 'var(--surface)', border: '1px solid var(--border)' }),
      }}
    >
      {header !== undefined && (
        <div className="shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>{header}</div>
      )}
      {search && (
        <div className="p-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? 'Search…'}
            autoFocus={search.autoFocus}
            className="w-full rounded-md px-2.5 py-1.5 text-xs"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </div>
      )}
      {/* A flex column so a body that wants to center itself (a setup form) can */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden flex flex-col">{children}</div>
      {footer !== undefined && (
        <div className="shrink-0" style={{ borderTop: '1px solid var(--border)' }}>{footer}</div>
      )}
    </div>
  )
}

export function RailGroup({ label, count, mark, collapsed, onToggle, children }: {
  label: string
  count?: number
  mark?: ReactNode
  /** When onToggle is given the header is a collapse control. */
  collapsed?: boolean
  onToggle?: () => void
  children?: ReactNode
}) {
  const head = (
    <>
      {onToggle && <span className="w-3 text-center">{collapsed ? '▸' : '▾'}</span>}
      {mark}
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="ml-auto font-normal opacity-70">{count}</span>}
    </>
  )
  const cls = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide'
  const style = {
    color: 'var(--muted)',
    background: 'color-mix(in srgb, var(--border) 18%, transparent)',
    borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
  } as const
  return (
    <div>
      {onToggle
        ? <button type="button" onClick={onToggle} className={cls} style={style}>{head}</button>
        : <div className={cls} style={style}>{head}</div>}
      {!collapsed && children}
    </div>
  )
}

export function RailItem({ title, subtitle, mark, right, active = false, onClick, onDoubleClick, checkbox, title_, dataAttrs }: {
  title: ReactNode
  subtitle?: ReactNode
  /** Left mark: a TypeMark, a status dot, a letter chip. */
  mark?: ReactNode
  /** Right-hand meta: a value, a count, a badge. */
  right?: ReactNode
  active?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  /** Multi-select rows: draw a checkbox as the mark, checked = active. */
  checkbox?: boolean
  /** Native title attribute (tooltip). */
  title_?: string
  dataAttrs?: Record<string, string>
}) {
  const box = checkbox && (
    <span
      aria-hidden
      className="shrink-0 grid place-items-center rounded"
      style={{
        width: 14, height: 14, marginTop: 3,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent)' : 'transparent',
        color: '#fff', fontSize: 10, lineHeight: 1,
      }}
    >
      {active ? '✓' : ''}
    </span>
  )
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title_}
      {...dataAttrs}
      className="hoverable hoverable-flat w-full text-left px-3 py-2.5 flex items-start gap-2.5"
      style={{
        background: active ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
      }}
    >
      {box || (mark !== undefined && <span className="shrink-0 mt-0.5 grid place-items-center">{mark}</span>)}
      <span className="min-w-0 flex-1">
        <span className="block text-sm truncate" style={{ color: 'var(--foreground)' }}>{title}</span>
        {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
          <span className="block text-xs truncate mt-0.5" style={{ color: 'var(--muted)' }}>{subtitle}</span>
        )}
      </span>
      {right !== undefined && <span className="shrink-0 text-right text-xs" style={{ color: 'var(--muted)' }}>{right}</span>}
    </button>
  )
}

/** A small status dot for a mark slot. */
export function StatusDot({ color = 'var(--success)', title }: { color?: string; title?: string }) {
  return <span title={title} className="inline-block w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
}
