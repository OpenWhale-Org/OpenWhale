'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useAnchoredPlacement } from './popover'
import { useT } from '@/i18n'

/** Options from here up get a search box; below it, the list is short enough to read. */
const SEARCH_FROM = 8

/**
 * A select drawn in the dashboard's own list style rather than the browser's.
 *
 * Native <select> popups ignore the theme entirely — a white Aqua list under a
 * dark panel — and cannot carry a mark or a two-line entry. This is a button
 * that opens a popover of menu-item rows, the same rows the kebab menu and
 * the rails use, so a picker looks like the lists around it.
 *
 * The list is portalled to <body> and positioned fixed. An absolutely
 * positioned popover is clipped by any ancestor with `overflow: hidden` — the
 * parameter form's section boxes are exactly that, so a select near the bottom
 * of a section showed a sliver of its options and nothing else.
 */

export interface SelectOption {
  value: string
  label: ReactNode
  /** What typing matches against, when the label is not plain text. Defaults to the label (if a string) and the value. */
  search?: string
  /** Second line, muted. */
  hint?: ReactNode
  /** Left mark: a TypeMark, a dot. */
  mark?: ReactNode
  disabled?: boolean
}

export function Select({ value, options, onChange, placeholder = '—', size = 'md', className = '', style, disabled, searchable }: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: ReactNode
  size?: 'sm' | 'md'
  className?: string
  style?: React.CSSProperties
  disabled?: boolean
  /**
   * Force the search box on or off. Left out, it appears once the list is
   * long enough to scroll — a picker of four venues does not need a box to
   * type in, and a picker of ninety symbols is unusable without one.
   */
  searchable?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const current = options.find(o => o.value === value)
  const withSearch = searchable ?? options.length >= SEARCH_FROM
  /* Matching is on the words, in any order: "bz usdt" finds
     "BZ/USDT:USDT · short $91,395", and so does "usdt bz". */
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = terms.length === 0 ? options : options.filter((o) => {
    const text = `${o.search ?? (typeof o.label === 'string' ? o.label : '')} ${o.value}`.toLowerCase()
    return terms.every(term => text.includes(term))
  })

  useEffect(() => {
    if (!open) return
    const onAway = (e: MouseEvent) => {
      const t = e.target as Node
      if (!boxRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onAway)
    return () => document.removeEventListener('mousedown', onAway)
  }, [open])

  const place = useAnchoredPlacement(open, boxRef, { maxHeight: 288 })

  useEffect(() => {
    if (!open) { setQuery(''); return }
    setCursor(Math.max(0, options.findIndex(o => o.value === value)))
    // Open with the caret in the box: the point of it is to type straight away.
    if (withSearch) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, options, value, withSearch])

  // A new query re-aims the cursor at the first match, so Enter takes it.
  useEffect(() => { if (open && query) setCursor(0) }, [open, query])

  useEffect(() => {
    if (!open || cursor < 0) return
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [open, cursor])

  const pick = (o: SelectOption) => { if (o.disabled) return; onChange(o.value); setOpen(false) }

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(shown.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[cursor]; if (o) pick(o) }
  }

  const h = size === 'sm' ? 'h-8 text-xs px-2' : 'h-9 text-sm px-3'

  return (
    <div ref={boxRef} className={`relative ${className}`} style={style} onKeyDown={onKey}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full rounded-md flex items-center gap-2 text-left ${h}`}
        style={{
          background: 'var(--background)', color: current ? 'var(--foreground)' : 'var(--muted)',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`, opacity: disabled ? 0.6 : 1,
        }}
      >
        {current?.mark !== undefined && <span className="shrink-0 grid place-items-center">{current.mark}</span>}
        <span className="min-w-0 flex-1 truncate">{current ? current.label : placeholder}</span>
        <span aria-hidden className="shrink-0" style={{ color: 'var(--muted)', fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && place && createPortal(
        <div
          ref={listRef}
          role="listbox"
          className="fixed z-[200] rounded-md shadow-lg flex flex-col py-1 overflow-y-auto scroll-hidden"
          onKeyDown={onKey}
          style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            left: place.left, width: place.width, maxHeight: place.maxHeight,
            ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
          }}
        >
          {withSearch && (
            /* Sticky, so it stays reachable while the list scrolls under it. */
            <div className="sticky top-0 px-1.5 pb-1 pt-0.5" style={{ background: 'var(--surface)' }}>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('ui.filterOptions')}
                className="w-full rounded px-2 py-1 text-xs"
                style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              />
            </div>
          )}
          {shown.length === 0 && (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
              {options.length === 0 ? t('ui.nothingToChoose') : t('ui.noMatch')}
            </div>
          )}
          {shown.map((o, i) => {
            const selected = o.value === value
            return (
              <button
                key={o.value || `__empty_${i}`}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={o.disabled}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(o)}
                className="menu-item w-full text-left px-3 py-1.5 flex items-start gap-2"
                style={{
                  background: i === cursor ? 'var(--selection)' : 'transparent',
                  boxShadow: i === cursor ? 'inset 2px 0 0 var(--accent)' : 'none',
                  color: o.disabled ? 'var(--muted)' : 'var(--foreground)',
                  opacity: o.disabled ? 0.6 : 1,
                }}
              >
                {o.mark !== undefined && <span className="shrink-0 mt-0.5 grid place-items-center">{o.mark}</span>}
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${size === 'sm' ? 'text-xs' : 'text-sm'}`}>{o.label}</span>
                  {o.hint !== undefined && <span className="block text-xs truncate" style={{ color: 'var(--muted)' }}>{o.hint}</span>}
                </span>
                {selected && <span className="shrink-0 text-xs" style={{ color: 'var(--accent)' }}>✓</span>}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
