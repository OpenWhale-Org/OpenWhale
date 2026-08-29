'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ParamFieldCatalogue } from '@openwhaleorg/core'
import { useAnchoredPlacement } from './popover'

/**
 * Searchable market picker — the symbol equivalent of a select, for a
 * candidate set too large to inline (a venue lists thousands of markets).
 *
 * Deliberately a combobox and not a <select>: the value stays free text, so
 * an unlisted symbol, a venue with no catalogue, or an offline gateway all
 * degrade to typing it by hand rather than blocking the form. The fetched
 * list is an aid, never a constraint.
 */

export interface MarketInfo {
  symbol: string
  base: string
  quote: string
  type: string
  active: boolean
  settle?: string
}

/**
 * Module-scoped cache keyed by (kind, venue). A form with two symbol fields
 * on the same venue must not fetch the catalogue twice, and reopening a
 * dropdown should be instant — in-flight promises are shared, not restarted.
 */
const catalogueCache = new Map<string, Promise<MarketInfo[]>>()

function loadMarkets(venue: string, kind: string): Promise<MarketInfo[]> {
  const key = `${kind}::${venue}`
  const cached = catalogueCache.get(key)
  if (cached) return cached

  const promise = (async () => {
    const res = await fetch(`/api/markets?venue=${encodeURIComponent(venue)}&kind=${encodeURIComponent(kind)}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    return await res.json() as MarketInfo[]
  })()
  // A failed fetch must not be cached as permanent — the venue may just be
  // briefly unreachable, and the user will reopen the dropdown to retry.
  promise.catch(() => catalogueCache.delete(key))
  catalogueCache.set(key, promise)
  return promise
}

/** Rank matches so exact/prefix hits beat incidental substring ones. */
function score(market: MarketInfo, query: string): number {
  const symbol = market.symbol.toUpperCase()
  const base = market.base.toUpperCase()
  if (symbol === query || base === query) return 0
  if (base.startsWith(query)) return 1
  if (symbol.startsWith(query)) return 2
  if (symbol.includes(query)) return 3
  return 4
}

const MAX_VISIBLE = 60

export function SymbolPicker({
  value,
  onChange,
  venue,
  catalogue,
  placeholder,
  title,
  required,
  className,
  style,
  multiple,
}: {
  value: string
  onChange: (value: string) => void
  /** Resolved venue — from the sibling field or the form's account context. */
  venue: string | undefined
  catalogue: ParamFieldCatalogue
  placeholder?: string
  title?: string
  required?: boolean
  className?: string
  style?: React.CSSProperties
  /** Multi-select: value is a CSV of symbols, dropdown rows toggle with checkboxes. */
  multiple?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [markets, setMarkets] = useState<MarketInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [highlight, setHighlight] = useState(0)
  // Multi mode separates what the user TYPES (the search) from what is CHOSEN
  // (the CSV value) — a single text input cannot be both at once.
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const kind = catalogue.kind ?? 'exchange/perp'
  const chosen = useMemo(
    () => (multiple ? value.split(',').map(s => s.trim()).filter(Boolean) : []),
    [multiple, value],
  )
  const searchText = multiple ? query : value

  function toggle(symbol: string) {
    const next = chosen.includes(symbol) ? chosen.filter(s => s !== symbol) : [...chosen, symbol]
    onChange(next.join(','))
    setQuery('')
  }

  // Fetch lazily — only once the user actually opens the dropdown, so a form
  // with picker fields costs nothing until one is used.
  useEffect(() => {
    if (!open || !venue) return
    let cancelled = false
    setLoading(true)
    setError('')
    loadMarkets(venue, kind)
      .then(rows => { if (!cancelled) setMarkets(rows) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, venue, kind])

  // Switching venue invalidates the shown list — a BTC symbol from one venue
  // is not necessarily listed on another.
  useEffect(() => { setMarkets([]) }, [venue, kind])

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      const t = e.target as Node
      // The list is portalled to <body>, so it is not inside boxRef
      if (!boxRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  /* Portalled and viewport-positioned: this picker is used inside modals and
     inside the parameter form's `overflow: hidden` sections, both of which
     clip an absolutely positioned list. */
  const place = useAnchoredPlacement(open, boxRef, { maxHeight: 256, minWidth: 256 })

  const matches = useMemo(() => {
    const q = searchText.trim().toUpperCase()
    const eligible = markets.filter(m =>
      m.active && (!catalogue.marketType || m.type === catalogue.marketType))
    if (!q) return eligible.slice(0, MAX_VISIBLE)
    return eligible
      .map(m => ({ m, s: score(m, q) }))
      .filter(x => x.s < 4)
      .sort((a, b) => a.s - b.s || a.m.symbol.length - b.m.symbol.length)
      .slice(0, MAX_VISIBLE)
      .map(x => x.m)
  }, [markets, searchText, catalogue.marketType])

  useEffect(() => { setHighlight(0) }, [searchText, open])

  function commit(symbol: string) {
    if (multiple) { toggle(symbol); return }   // stays open — picking several is the point
    onChange(symbol)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return }
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') {
      const pick = matches[highlight]
      if (pick) { e.preventDefault(); commit(pick.symbol) }
      // Multi with no match: the typed text itself is addable — unlisted
      // symbols and plain base names stay first-class.
      else if (multiple && query.trim() !== '') { e.preventDefault(); commit(query.trim().toUpperCase()) }
    } else if (e.key === 'Backspace' && multiple && query === '' && chosen.length > 0) {
      toggle(chosen[chosen.length - 1]!)
    }
  }

  return (
    <div ref={boxRef} className="relative">
      {multiple && chosen.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {chosen.map(sym => (
            <span
              key={sym}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono"
              style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              {sym}
              <button
                type="button"
                onClick={() => toggle(sym)}
                style={{ color: 'var(--muted)' }}
                aria-label={`remove ${sym}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={multiple ? query : value}
        onChange={(e) => { multiple ? setQuery(e.target.value) : onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={multiple && chosen.length > 0 ? 'Search to add more…' : placeholder}
        title={title}
        required={required && !(multiple && chosen.length > 0)}
        autoComplete="off"
        className={className}
        style={style}
      />
      {open && place && createPortal(
        <div
          ref={listRef}
          className="fixed z-[200] overflow-y-auto rounded-md shadow-lg"
          style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            left: place.left, width: place.width, maxHeight: place.maxHeight,
            ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
          }}
        >
          {!venue ? (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
              {catalogue.venueField
                ? `Pick a ${catalogue.venueField} first to list its markets.`
                : 'Bind an account first to list its venue\'s markets.'}
            </p>
          ) : loading && markets.length === 0 ? (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>Loading {venue} markets…</p>
          ) : error ? (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
              {error} — type the symbol manually.
            </p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
              {markets.length === 0 ? `No markets listed for ${venue}.` : 'No match — the typed value is used as-is.'}
            </p>
          ) : (
            <ul>
              {matches.map((m, i) => (
                <li key={m.symbol}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => { e.preventDefault(); commit(m.symbol) }}
                    className="w-full text-left px-3 py-1.5 text-xs font-mono flex items-baseline justify-between gap-2"
                    style={{ background: i === highlight ? 'var(--selection)' : 'transparent', color: 'var(--foreground)', boxShadow: i === highlight ? 'inset 2px 0 0 var(--accent)' : 'none' }}
                  >
                    <span className="flex items-baseline gap-2">
                      {multiple && (
                        <span style={{ color: chosen.includes(m.symbol) ? 'var(--accent)' : 'var(--muted)' }}>
                          {chosen.includes(m.symbol) ? '☑' : '☐'}
                        </span>
                      )}
                      <span>{m.symbol}</span>
                    </span>
                    <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
                      {m.base}/{m.quote}{m.type !== 'swap' ? ` · ${m.type}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
