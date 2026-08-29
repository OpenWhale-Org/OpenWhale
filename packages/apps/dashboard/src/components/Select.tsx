'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useAnchoredPlacement } from './popover'

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
  /** Second line, muted. */
  hint?: ReactNode
  /** Left mark: a TypeMark, a dot. */
  mark?: ReactNode
  disabled?: boolean
}

export function Select({ value, options, onChange, placeholder = '—', size = 'md', className = '', style, disabled }: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: ReactNode
  size?: 'sm' | 'md'
  className?: string
  style?: React.CSSProperties
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const current = options.find(o => o.value === value)

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
    if (!open) return
    setCursor(Math.max(0, options.findIndex(o => o.value === value)))
  }, [open, options, value])

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
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(options.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[cursor]; if (o) pick(o) }
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
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>Nothing to choose from.</div>
          )}
          {options.map((o, i) => {
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
