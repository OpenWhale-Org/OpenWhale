'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable, DragHandle } from '../../components/Sortable'
import { useLayout, LayoutSwitch, LAYOUTS } from '../../components/LayoutSwitch'
import dynamic from 'next/dynamic'
import type { WhaleDatum, WhaleFieldHandle } from '../../components/WhaleField'

/* three.js is ~170 kB and only the 3D view needs it — statically imported it
   rode along on every visit to this page. Loaded on demand instead, so picking
   the view is what pays for it. ssr:false because the scene wants a canvas. */
const WhaleField = dynamic(
  () => import('../../components/WhaleField').then(m => m.WhaleField),
  {
    ssr: false,
    loading: () => (
      <div
        className="w-full rounded-lg grid place-items-center text-xs"
        style={{ height: 'calc(100vh - 22rem)', minHeight: 420, color: 'var(--muted)', border: '1px solid var(--border)' }}
      >
        Diving…
      </div>
    ),
  },
)
import { KebabMenu, FolderSection, MENU_ITEM } from '../../components/CardMenu'
import Link from 'next/link'
import type { StrategyInstance, StrategyInstanceView } from '@openwhaleorg/core'
import type { StrategyDefinition, CredentialInfo, ParamFieldDef, ParamIllustration, ExecutionResult } from '@openwhaleorg/core'
import { subscribeLiveEvents } from '@/lib/live-events'
import { SymbolPicker } from '@/components/SymbolPicker'
import { Modal, ModalMaximizeButton } from '@/components/Modal'
import { StatsBar } from './StatsBar'
import { StrategyBrowser } from './StrategyPicker'

// ── SSE event types ───────────────────────────────────────────────────────────

interface MonitorEmitEvent {
  type: 'monitor_emit'
  monitor: string
  key: string
  data: unknown
  ts: number
}

interface StrategyRunEvent {
  type: 'strategy_run'
  instanceId: string
  triggerId: string
  monitorData: Record<string, unknown>
  instructions: Array<{ action: string; executorId: string; params: Record<string, unknown> }>
  timestamp: number
}

type LiveEvent = MonitorEmitEvent | StrategyRunEvent

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

// ── Instance icons ────────────────────────────────────────────────────────────
const SORTS = [
  { id: 'manual', label: 'Manual order' },
  { id: 'name', label: 'Name A→Z' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'pnl', label: 'PnL high→low' },
  { id: 'pnl-asc', label: 'PnL low→high' },
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
] as const

type SortId = typeof SORTS[number]['id']

/* The strategies page adds a third view to the shared two. */
const INSTANCE_LAYOUTS = [...LAYOUTS, { id: 'whale', label: '3D', glyph: '🐋', hint: 'The pod, in open water' }]

const ICON_POOL = ['🐋', '🐙', '🦈', '🐬', '🦑', '🐡', '🐳', '🦞', '🐊', '🦭', '⚡', '🔥', '🌊', '🌀', '☄️', '🛰️', '🧭', '⚙️', '🎯', '🧲', '💎', '🪙', '📈', '🚀']

/** Persisted icon, else a stable pick derived from the id — no flicker, no write. */
export function iconFor(instance: { id: string; icon?: string }): string {
  if (instance.icon) return instance.icon
  let h = 0
  for (const ch of instance.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return ICON_POOL[h % ICON_POOL.length]!
}

export const randomIcon = (): string => ICON_POOL[Math.floor(Math.random() * ICON_POOL.length)]!

/** The picker grid: the pool first, then a broader set of common picks. */
const EMOJI_GRID = [
  ...ICON_POOL,
  '🦄', '🐲', '🦅', '🦉', '🐺', '🦁', '🐯', '🐸', '🐢', '🐝', '🦋', '🌟',
  '🌙', '☀️', '🌈', '🌪️', '🌋', '🏔️', '🗻', '🏝️', '🧊', '💧', '🫧', '🌌',
  '🍀', '🌵', '🌸', '🍁', '🎲', '🎰', '🃏', '🎮', '🏆', '🥇', '🎖️', '🏅',
  '🔮', '🧿', '💰', '💵', '💳', '🏦', '⏳', '⏰', '🔔', '📊', '📉', '🧮',
  '🔒', '🔑', '🛡️', '⚔️', '🪃', '🏹', '🧪', '🧬', '🔬', '🔭', '📡', '💡',
]

/**
 * Notion-style inline emoji picker — a grid popover, never a browser prompt.
 */
export function IconMenu({ current, onPick, children }: {
  current: string
  onPick: (emoji: string) => void
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  return (
    <div ref={boxRef} className="relative inline-block">
      <span className="cursor-pointer" title="Click to change the icon" onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}>
        {children}
      </span>
      {open && (
        <div
          className="absolute left-0 z-[100] mt-1 rounded-md shadow-lg p-2"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', width: '16.5rem' }}
        >
          <div className="grid grid-cols-8 gap-0.5 max-h-48 overflow-y-auto">
            {EMOJI_GRID.map(e => (
              <button
                key={e}
                type="button"
                onClick={() => { onPick(e); setOpen(false) }}
                className="text-lg leading-none p-1 rounded hover:scale-110"
                style={{ background: e === current ? 'var(--background)' : 'transparent' }}
              >
                {e}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { onPick(''); setOpen(false) }}
            className="w-full text-left text-xs mt-1 px-1 py-1"
            style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}
          >
            Reset to default (random)
          </button>
        </div>
      )}
    </div>
  )
}

export async function patchInstanceMeta(id: string, patch: Record<string, unknown>): Promise<void> {
  await fetch(`/api/instances/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

interface Props {
  initialInstances: StrategyInstanceView[]
}

// ── Generic param fields form ─────────────────────────────────────────────────

function isFieldVisible(field: ParamFieldDef, values: Record<string, string>): boolean {
  const { displayOptions } = field
  if (!displayOptions) return true

  if (displayOptions.show) {
    for (const [key, allowed] of Object.entries(displayOptions.show)) {
      const current = values[key] ?? ''
      if (!allowed.map(String).includes(current)) return false
    }
  }
  if (displayOptions.hide) {
    for (const [key, blocked] of Object.entries(displayOptions.hide)) {
      const current = values[key] ?? ''
      if (blocked.map(String).includes(current)) return false
    }
  }
  return true
}

/** value → verdict; null means "checked and fine". */
type FieldAvailability = Record<string, Record<string, { available: boolean; reason?: string } | null>>

type ListRow = Record<string, unknown>

function parseListRows(raw: string): ListRow[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v as ListRow[] : []
  } catch { return [] }
}

/** A number input, optionally paired with a drag slider when the column declares a range. */
function NumberCell({ value, onChange, slider, unit, placeholder }: {
  value: unknown
  onChange: (v: number) => void
  slider?: { min: number; max: number; step?: number }
  unit?: string
  placeholder?: string
}) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {slider && (
        <input
          type="range"
          min={slider.min} max={slider.max} step={slider.step ?? 'any'}
          value={isNaN(n) ? slider.min : n}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1 min-w-[60px] accent-[var(--accent)]"
        />
      )}
      <input
        type="number"
        value={isNaN(n) ? '' : n}
        step="any"
        placeholder={placeholder}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v) }}
        className="w-16 rounded px-1.5 py-1 text-xs text-right"
        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
      />
      {unit && <span className="text-xs" style={{ color: 'var(--muted)' }}>{unit}</span>}
    </span>
  )
}

/**
 * Editor for a `list` param — an ordered table of uniform rows (ladder rungs,
 * tier tables). Value is stored as a JSON array string in the form state.
 */
function ListParamEditor({ field, value, onChange, venueContext }: {
  field: ParamFieldDef
  value: string
  onChange: (v: string) => void
  venueContext?: string
}) {
  const columns = field.list?.columns ?? []
  const rows = parseListRows(value)
  const commit = (next: ListRow[]) => onChange(JSON.stringify(next))

  const setCell = (i: number, name: string, v: unknown) =>
    commit(rows.map((r, j) => j === i ? { ...r, [name]: v } : r))

  const addRow = () => {
    // New row starts from column defaults, else copies the last row.
    const last = rows[rows.length - 1]
    const fresh: ListRow = {}
    for (const c of columns) fresh[c.name] = c.default !== undefined ? c.default : (last?.[c.name] ?? (c.type === 'number' ? 0 : c.type === 'boolean' ? false : ''))
    commit([...rows, fresh])
  }

  if (columns.length === 0) {
    // No column schema — degrade to a raw JSON textarea rather than hiding the value.
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="rounded-md px-3 py-2 text-xs font-mono"
        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="grid gap-2 items-center text-xs font-medium" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0,1fr)) 1.5rem`, color: 'var(--muted)' }}>
        {columns.map(c => <span key={c.name} title={c.description}>{c.displayName}</span>)}
        <span />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0,1fr)) 1.5rem` }}>
          {columns.map((c) => {
            const v = row[c.name]
            if (c.type === 'number') {
              return <NumberCell key={c.name} value={v} onChange={(nv) => setCell(i, c.name, nv)} slider={c.slider} unit={c.unit} placeholder={c.placeholder} />
            }
            if (c.type === 'boolean') {
              return (
                <input key={c.name} type="checkbox" checked={v === true}
                  onChange={(e) => setCell(i, c.name, e.target.checked)} className="justify-self-start" />
              )
            }
            if (c.catalogue) {
              return (
                <SymbolPicker
                  key={c.name}
                  value={String(v ?? '')}
                  onChange={(nv) => setCell(i, c.name, nv)}
                  venue={c.catalogue.venueField ? undefined : venueContext}
                  catalogue={c.catalogue}
                  placeholder={c.placeholder}
                  title={c.description}
                  className="rounded px-1.5 py-1 text-xs font-mono w-full"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                />
              )
            }
            if (c.type === 'options' && c.options) {
              return (
                <select key={c.name} value={String(v ?? '')} onChange={(e) => setCell(i, c.name, e.target.value)}
                  className="rounded px-1.5 py-1 text-xs"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                  {c.options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                </select>
              )
            }
            return (
              <input key={c.name} type="text" value={String(v ?? '')} placeholder={c.placeholder}
                onChange={(e) => setCell(i, c.name, e.target.value)}
                className="rounded px-1.5 py-1 text-xs"
                style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
            )
          })}
          <button type="button" onClick={() => commit(rows.filter((_, j) => j !== i))}
            className="text-xs" style={{ color: 'var(--muted)' }} title="Remove row">✕</button>
        </div>
      ))}
      <button type="button" onClick={addRow}
        className="self-start text-xs px-2 py-1 rounded"
        style={{ color: 'var(--accent)', border: '1px dashed var(--border)' }}>
        ＋ {field.list?.addLabel ?? 'Add row'}
      </button>
    </div>
  )
}

/**
 * A strategy-authored HTML doc in a sandboxed iframe. The page gets the live
 * form values pushed via postMessage on every edit (and once on load), so it
 * can draw diagrams that react to what the user is typing. Scripts run, but
 * same-origin is denied — the page can't touch the dashboard or its cookies.
 */
function IllustrationFrame({ ill, values }: { ill: ParamIllustration; values: Record<string, string> }) {
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ type: 'ow-params', values }, '*')
  }, [values])
  return (
    <div className="flex flex-col gap-1">
      {ill.title && <span className="text-xs" style={{ color: 'var(--muted)' }}>{ill.title}</span>}
      <iframe
        ref={ref}
        sandbox="allow-scripts"
        srcDoc={ill.html}
        onLoad={() => ref.current?.contentWindow?.postMessage({ type: 'ow-params', values }, '*')}
        className="w-full rounded-md"
        style={{ height: ill.height ?? 220, border: '1px solid var(--border)', background: 'var(--surface)' }}
      />
    </div>
  )
}

export function ParamFieldsForm({
  fields,
  values,
  onChange,
  venueContext,
  strategyId,
  illustrations,
}: {
  fields: ParamFieldDef[]
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
  /** Strategy-declared interactive docs, keyed into sections via their `section`. */
  illustrations?: ParamIllustration[]
  /** Strategy whose availability checkers to call. */
  strategyId?: string
  /**
   * Venue for catalogue pickers whose fields declare no venueField — strategy
   * params never carry a venue (it derives from the bound account), so the
   * form supplies it from the slot bindings.
   */
  venueContext?: string
}) {
  // Which parameter groups are folded away, remembered per strategy: tuning
  // one knob in a forty-parameter form should not mean scrolling past the
  // thirty-nine others every time.
  const collapseKey = `ow:params-collapsed:${strategyId ?? 'default'}`
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(collapseKey)
      setCollapsed(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch { /* a broken entry just means everything shows */ }
  }, [collapseKey])
  const persistCollapsed = (next: Set<string>) => {
    setCollapsed(next)
    try { window.localStorage.setItem(collapseKey, JSON.stringify([...next])) } catch { /* private mode */ }
  }
  const toggleSection = (key: string) => {
    const next = new Set(collapsed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    persistCollapsed(next)
  }
  const setAllCollapsed = (collapse: boolean) => {
    persistCollapsed(collapse
      ? new Set([...new Set(fields.filter(f => f.group === 'tunable').map(f => (f.section ?? '') || 'general'))])
      : new Set())
  }

  const [availability, setAvailability] = useState<FieldAvailability>({})

  // Verify chosen values against the venue whenever either changes. Advisory:
  // a failure to check leaves the field unannotated rather than blocking.
  useEffect(() => {
    if (!strategyId || !venueContext) return
    let cancelled = false
    const checked = fields.filter(f => f.availability && (values[f.name] ?? '').length > 0)
    if (checked.length === 0) return
    void Promise.all(checked.map(async (f) => {
      const vals = (values[f.name] ?? '').split(',').filter(Boolean)
      const res = await fetch(`/api/strategies/${encodeURIComponent(strategyId)}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: f.name, values: vals, venue: venueContext }),
      })
      if (!res.ok) return [f.name, {}] as const
      const { verdicts } = await res.json() as { verdicts: Array<{ value: string; available: boolean; reason?: string }> }
      const byValue: Record<string, { available: boolean; reason?: string } | null> = {}
      for (const v of verdicts) byValue[v.value] = v.reason || !v.available ? { available: v.available, ...(v.reason ? { reason: v.reason } : {}) } : null
      return [f.name, byValue] as const
    })).then((entries) => {
      if (!cancelled) setAvailability(Object.fromEntries(entries))
    }).catch(() => { /* advisory */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, venueContext, JSON.stringify(fields.map(f => [f.name, values[f.name]]))])

  const baseFields = fields.filter((f) => f.group === 'base')
  const tunableFields = fields.filter((f) => f.group === 'tunable')

  function set(name: string, value: string) {
    onChange({ ...values, [name]: value })
  }

  function renderField(field: ParamFieldDef) {
    if (!isFieldVisible(field, values)) return null
    const value = values[field.name] ?? ''

    if (field.type === 'boolean') {
      const checked = value === 'true'
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <button
            type="button"
            onClick={() => set(field.name, checked ? 'false' : 'true')}
            className="relative w-10 h-5 rounded-full transition-colors self-start"
            style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
          >
            <span
              className="absolute top-0.5 left-0 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: checked ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }}
            />
          </button>
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    // Multi-select: several options, stored comma-separated, each verified
    // against the bound account's venue when the field declares a check.
    if (field.multiple && field.options) {
      const chosen = value ? value.split(',').filter(Boolean) : []
      const toggle = (v: string) => {
        const next = chosen.includes(v) ? chosen.filter(x => x !== v) : [...chosen, v]
        set(field.name, next.join(','))
      }
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>— {chosen.length} selected</span>
          </div>
          <div className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {field.options.map((opt) => {
              const v = String(opt.value)
              const on = chosen.includes(v)
              const verdict = availability?.[field.name]?.[v]
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggle(v)}
                  className="flex items-start gap-2 text-left text-xs px-2 py-1.5 rounded"
                  style={{ background: on ? 'var(--background)' : 'transparent' }}
                >
                  <span style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}>{on ? '☑' : '☐'}</span>
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span style={{ color: 'var(--foreground)' }}>{opt.label}</span>
                    {/* Verdicts are advisory — a warning still submits */}
                    {on && verdict && (
                      <span style={{ color: verdict.available ? 'var(--warning)' : 'var(--danger)' }}>
                        {verdict.available ? '⚠ ' : '✕ '}{verdict.reason ?? ''}
                      </span>
                    )}
                    {on && verdict === null && <span style={{ color: 'var(--success)' }}>✓ available</span>}
                    {opt.description && !on && <span style={{ color: 'var(--muted)' }}>{opt.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    if (field.type === 'list') {
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <ListParamEditor field={field} value={value} onChange={(v) => set(field.name, v)} venueContext={venueContext} />
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    // A bounded number can be dragged instead of typed.
    if (field.type === 'number' && field.slider) {
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <NumberCell
            value={value === '' ? undefined : parseFloat(value)}
            onChange={(v) => set(field.name, String(v))}
            slider={field.slider}
            unit={field.unit}
            placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
          />
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    if (field.type === 'options' && field.options) {
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <select
            value={value}
            onChange={(e) => set(field.name, e.target.value)}
            required={field.required}
            className="input"
          >
            {field.options.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
            ))}
          </select>
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    if (field.catalogue) {
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <SymbolPicker
            value={value}
            onChange={(v) => set(field.name, v)}
            venue={field.catalogue.venueField ? values[field.catalogue.venueField] : venueContext}
            catalogue={field.catalogue}
            placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
            title={field.description}
            required={field.required}
            multiple={field.multiple}
            className="input mono"
          />
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    // string / number
    return (
      <div key={field.name} className="flex flex-col gap-1">
        <div className="flex items-baseline gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
            {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
          </span>
          {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
        </div>
        <div className="flex items-center gap-2">
          <input
            type={field.type === 'number' ? 'number' : 'text'}
            value={value}
            onChange={(e) => set(field.name, e.target.value)}
            placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
            required={field.required}
            step={field.type === 'number' ? 'any' : undefined}
            className="input flex-1"
          />
          {/* The unit is half the meaning of a number — 6 what? */}
          {field.unit && <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{field.unit}</span>}
        </div>
        {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
      </div>
    )
  }

  const illsFor = (sec: string) => (illustrations ?? []).filter(i => (i.section ?? '') === sec)

  const sections = [...new Set(tunableFields.map(f => f.section ?? ''))]
  const fieldsIn = (sec: string) => tunableFields.filter(f => (f.section ?? '') === sec)
  /** Fields the operator has moved off the strategy's default — what a collapsed group is hiding. */
  const editedIn = (sec: string) => fieldsIn(sec).filter((f) => {
    const v = values[f.name]
    if (v === undefined || v === '') return false
    return f.default === undefined ? true : v !== String(f.default)
  }).length

  const allCollapsed = sections.length > 0 && sections.every(sec => collapsed.has(sec || 'general'))

  return (
    <div className="flex flex-col gap-3">
      {illsFor('').map((ill, i) => <IllustrationFrame key={`top-${i}`} ill={ill} values={values} />)}
      {baseFields.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Base Parameters</label>
          <div className="rounded-md p-3 flex flex-col gap-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            {baseFields.map(renderField)}
          </div>
        </div>
      )}
      {tunableFields.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Tunable Parameters</label>
            {sections.length > 1 && (
              <button
                type="button"
                onClick={() => setAllCollapsed(!allCollapsed)}
                className="text-xs px-2 py-0.5 rounded-md"
                style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {/* Sections in first-appearance order; unsectioned fields group under General. */}
            {sections.map((sec) => {
              const key = sec || 'general'
              const isCollapsed = collapsed.has(key)
              const edited = editedIn(sec)
              return (
                <div key={key} className="rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  <button
                    type="button"
                    onClick={() => toggleSection(key)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                    style={{ background: 'var(--surface)' }}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                  >
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round"
                      style={{ color: 'var(--muted)', transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--foreground)' }}>
                      {sec || 'General'}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{fieldsIn(sec).length}</span>
                    {/* A collapsed group must still say whether anything inside it was touched. */}
                    {edited > 0 && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded-full"
                        style={{ background: 'var(--accent-soft, rgba(124,58,237,0.14))', color: '#a78bfa' }}
                      >
                        {edited} set
                      </span>
                    )}
                  </button>
                  {!isCollapsed && (
                    <div className="flex flex-col gap-3 p-3" style={{ background: 'var(--background)', borderTop: '1px solid var(--border)' }}>
                      {fieldsIn(sec).map(renderField)}
                      {sec !== '' && illsFor(sec).map((ill, i) => <IllustrationFrame key={`${sec}-${i}`} ill={ill} values={values} />)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Convert flat string values map → { base, tunable } params object */
export function buildParamsFromFields(
  fields: ParamFieldDef[],
  values: Record<string, string>,
): { base: Record<string, unknown>; tunable: Record<string, unknown> } {
  const base: Record<string, unknown> = {}
  const tunable: Record<string, unknown> = {}

  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    let parsed: unknown = raw
    if (field.type === 'number') {
      const n = parseFloat(raw)
      if (!isNaN(n)) parsed = n
    } else if (field.type === 'boolean') {
      parsed = raw === 'true'
    } else if (field.type === 'list') {
      try { parsed = JSON.parse(raw) } catch { continue }
    }
    if (field.group === 'base') base[field.name] = parsed
    else tunable[field.name] = parsed
  }

  return { base, tunable }
}

/** Initialise string values from field defaults */
function defaultFieldValues(fields: ParamFieldDef[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.type === 'list' ? JSON.stringify(f.default) : String(f.default)
  }
  return out
}

// ── Main component ────────────────────────────────────────────────────────────

export interface PnlTotals { realized: number; fees: number; funding: number; net: number; unrealized: number | null }

export function InstancesClient({ initialInstances }: Props) {
  const [instances, setInstances] = useState(initialInstances)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<StrategyInstanceView | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())

  const [layout, setLayout] = useLayout('ow:instances-layout', INSTANCE_LAYOUTS)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'running' | 'stopped'>('all')
  const [sort, setSort] = useState<SortId>('manual')
  /** 3D view only: which whale the pointer is on, and which one is selected. */
  const [whaleHover, setWhaleHover] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null)
  const [whaleSelected, setWhaleSelected] = useState<string | null>(null)
  /* Reordering lives in components/Sortable — every panel in the dashboard
     shares it. The handlers below close over `groups`, which is computed in
     the render body, so they are re-created each render and the hook reads
     them through a ref at pointer-up. */
  const sortable = useRef<{
    reorder: (order: string[]) => void
    refile: (id: string, folder: string) => void
    folder: (a: string, b: string) => void
  }>({ reorder: () => {}, refile: () => {}, folder: () => {} })
  const { beginDrag, cardStyle, folderStyle, refileStyle } = useSortable({
    onReorder: (order) => sortable.current.reorder(order),
    onRefile: (id, folder) => sortable.current.refile(id, folder),
    onFolderMove: (a, b) => sortable.current.folder(a, b),
  })

  const [pnl, setPnl] = useState<Record<string, PnlTotals>>({})
  const [statsKey, setStatsKey] = useState(0)

  const loadPnl = useCallback(async () => {
    const res = await fetch('/api/pnl/summary')
    if (res.ok) setPnl(await res.json() as Record<string, PnlTotals>)
  }, [])

  useEffect(() => {
    void loadPnl()
    const timer = setInterval(() => void loadPnl(), 30_000)
    return () => clearInterval(timer)
  }, [loadPnl])

  /* Filtering and sorting happen HERE, above every view — one derived list, so
     what you filtered to is what the grid, the list and the pod all show.

     Reordering switches off whenever a filter or a non-manual sort is on: the
     drag would have to write a sortOrder derived from a list that is not the
     real one, and dropping a card "after" a neighbour that is currently hidden
     means nothing. Saying so beats persisting a scrambled order. */
  const reorderable = sort === 'manual' && query.trim() === '' && status === 'all'

  const visible = (() => {
    const q = query.trim().toLowerCase()
    let out = instances
    if (status !== 'all') out = out.filter(i => i.active === (status === 'running'))
    if (q) {
      out = out.filter(i => {
        const accounts = i.credentials
          ? Object.values(i.credentials).join(' ')
          : (i.accounts ?? []).join(' ')
        return `${i.name} ${i.strategyId} ${accounts} ${i.folder ?? ''}`.toLowerCase().includes(q)
      })
    }
    if (sort === 'manual') return out
    // No reading sorts last rather than as zero — an instance that has never
    // traded is not "flat", and mixing it in with real zeros hides both.
    const net = (i: StrategyInstanceView) => pnl[i.id]?.net ?? Number.NEGATIVE_INFINITY
    const sorted = [...out]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'strategy') sorted.sort((a, b) => a.strategyId.localeCompare(b.strategyId) || a.name.localeCompare(b.name))
    else if (sort === 'pnl') sorted.sort((a, b) => net(b) - net(a))
    else if (sort === 'pnl-asc') sorted.sort((a, b) => net(a) - net(b))
    else if (sort === 'newest') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    else if (sort === 'oldest') sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return sorted
  })()

  const refresh = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/instances')
    if (res.ok) setInstances(await res.json())
    void loadPnl()
    setStatsKey(k => k + 1)
    setLoading(false)
  }, [loadPnl])

  async function act(id: string, verb: 'activate' | 'deactivate' | 'duplicate') {
    setActionError('')
    const res = await fetch(`/api/instances/${id}/${verb}`, { method: 'POST' })
    if (!res.ok) setActionError(await res.text())
    await refresh()
  }

  async function remove(id: string) {
    setActionError('')
    await fetch(`/api/instances/${id}`, { method: 'DELETE' })
    await refresh()
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Strategy Instances</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Activate and manage running strategy instances
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={refresh} disabled={loading} className="btn btn-secondary">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {/* The dialog covers the page, so this never needs to read "Cancel" —
              cancelling belongs to the dialog that has focus. */}
          <button onClick={() => { setEditing(null); setShowForm(true) }} className="btn btn-primary">
            + New Instance
          </button>
        </div>
      </div>

      {/* Re-reads whenever an action changes the world, so the numbers agree
          with the cards below instead of lagging a poll behind. */}
      <StatsBar refreshKey={statsKey} />

      {instances.length > 0 && (
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, strategy or account…"
            className="rounded-md px-3 h-8 text-xs min-w-0 flex-1"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
          <Segmented
            value={status}
            onChange={(v) => setStatus(v as typeof status)}
            options={[
              { id: 'all', label: 'All' },
              { id: 'running', label: 'Running' },
              { id: 'stopped', label: 'Stopped' },
            ]}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            className="rounded-md px-2 h-8 text-xs shrink-0"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            title="Sort order"
          >
            {SORTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
            {layout === 'whale'
              ? 'drag to orbit · wheel to zoom · arrows to move'
              : reorderable
                ? 'drag the ⠿ grip to reorder or re-file'
                : 'reordering is off while filtered or sorted'}
          </span>
          <LayoutSwitch value={layout} onChange={setLayout} options={INSTANCE_LAYOUTS} />
        </div>
      )}

      {actionError && (
        <p className="text-sm px-3 py-2 rounded-md mb-3" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {actionError}
        </p>
      )}

      {showForm && (
        <InstanceForm
          onSuccess={() => { setShowForm(false); void refresh() }}
          onCancel={() => setShowForm(false)}
        />
      )}
      {editing && (
        <InstanceForm
          initial={editing}
          onSuccess={() => { setEditing(null); void refresh() }}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* The list's three money columns are unlabelled numbers without this.
          It shares ROW_COLUMNS with the rows, so it cannot drift out of
          alignment with them — a header maintained separately eventually
          would. Sticky, because the folder groups make the list long. */}
      {layout === 'list' && visible.length > 0 && (
        <div
          className="grid items-center gap-3 px-3 py-1.5 mt-3 sticky z-20 rounded-md"
          style={{
            gridTemplateColumns: ROW_COLUMNS,
            top: 0,
            background: 'var(--background)',
            borderBottom: '1px solid var(--border)',
            color: 'var(--muted)',
          }}
        >
          <span />
          <span className="text-xs">Instance</span>
          <span className="text-xs">Strategy · Account</span>
          <span className="text-xs text-right">PnL</span>
          <span className="text-xs text-right">Unrealized</span>
          <span className="text-xs text-right">Funding</span>
          <span className="text-xs">Parameters</span>
          <span />
        </div>
      )}

      {instances.length === 0 ? (
        <EmptyState onNew={() => setShowForm(true)} />
      ) : visible.length === 0 ? (
        <div
          className="rounded-lg p-8 mt-4 text-center text-sm"
          style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px dashed var(--border)' }}
        >
          No instance matches this filter.
          <button
            type="button"
            onClick={() => { setQuery(''); setStatus('all') }}
            className="ml-2 underline"
            style={{ color: 'var(--accent)' }}
          >
            Clear it
          </button>
        </div>
      ) : layout === 'whale' ? (
        <WhaleLayout
          instances={visible}
          pnl={pnl}
          hover={whaleHover}
          selected={whaleSelected}
          onHover={(id, at) => setWhaleHover(id && at ? { id, ...at } : null)}
          onSelect={setWhaleSelected}
          onActivate={(id) => act(id, 'activate')}
          onDeactivate={(id) => act(id, 'deactivate')}
        />
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {(() => {
            const groups = groupByFolder(visible)
            const folderNames = groups.map(g => g.folder).filter((f): f is string => f !== undefined)

            /**
             * Commit an id order for one group. The drag has already decided
             * everything geometrically; all that is left is to renumber.
             */
            const dropCard = async (order: string[]) => {
              const gi = groups.findIndex(g => g.items.some(i => i.id === order[0]))
              if (gi < 0) return
              const byId = new Map(groups[gi]!.items.map(i => [i.id, i]))
              const next = groups.map((g, i) =>
                i === gi ? { ...g, items: order.map(x => byId.get(x)!).filter(Boolean) } : g)
              // Renumber locally first, with the exact same formula persistLayout
              // uses. Waiting for the round trip would repaint the OLD order for
              // a frame the moment the drag state clears — a visible flick back.
              const pos = new Map<string, number>()
              next.forEach((g, i) => g.items.forEach((inst, k) => pos.set(inst.id, i * 1000 + k * 10)))
              setInstances(prev => prev.map(x =>
                pos.has(x.id) ? { ...x, sortOrder: pos.get(x.id)! } : x))
              await persistLayout(next)
              await refresh()
            }

            /** Dropped over another folder's grid: re-file rather than reorder. */
            const refileCard = async (id: string, folder: string) => {
              await patchInstanceMeta(id, { folder })
              await refresh()
            }

            const dropFolder = async (dragName: string, targetName: string) => {
              if (dragName === targetName) return
              const next = groups.map(g => ({ ...g, items: [...g.items] }))
              const fi = next.findIndex(g => g.folder === dragName)
              const ti = next.findIndex(g => g.folder === targetName)
              if (fi < 0 || ti < 0) return
              const [moved] = next.splice(fi, 1)
              next.splice(ti, 0, moved!)
              await persistLayout(next)
              await refresh()
            }

            /* The pointer handlers live outside this render closure but the drop
               handlers need `groups`, which is computed inside it — so they are
               republished every render and read at pointer-up. */
            sortable.current = {
              reorder: (order) => { void dropCard(order) },
              refile: (id, folder) => { void refileCard(id, folder) },
              folder: (a, b) => { void dropFolder(a, b) },
            }

            /* No preview reorder here on purpose. The DOM order is left alone
               for the whole drag and every card is moved by transform instead;
               reordering mid-drag is what made the earlier versions flicker. */
            return groups.map(({ folder, items }) => (
              <div key={folder ?? '·'} className="flex flex-col gap-3">
                {folder !== undefined && (
                  <div
                    data-folder-id={folder}
                    className="flex items-center gap-2 mt-2 select-none"
                    style={folderStyle(folder)}
                  >
                    <button
                      className="flex items-center gap-2 text-left text-sm font-medium"
                      style={{ color: 'var(--foreground)' }}
                      onClick={() => setCollapsedFolders(prev => {
                        const next = new Set(prev)
                        if (!next.delete(folder)) next.add(folder)
                        return next
                      })}
                    >
                      <span>{collapsedFolders.has(folder) ? '▸' : '▾'}</span>
                      <span>📁 {folder}</span>
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>({items.length})</span>
                    </button>
                    {/* Hidden rather than disabled while filtered or sorted: a
                        grip you can grab but that refuses to do anything is
                        worse than no grip. */}
                    {reorderable && (
                      <DragHandle title="Drag to reorder folders" onPointerDown={(e) => beginDrag('folder', folder, e)} />
                    )}
                  </div>
                )}
                {folder === undefined && groups.length > 1 && (
                  <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Ungrouped</div>
                )}
                {/* A GRID, not a column: 13 instances as full-width rows is a
                    page you scroll rather than read. Cards stay drag-and-drop
                    targets exactly as before. */}
                {(folder === undefined || !collapsedFolders.has(folder)) && (
                <div
                  data-cards={folder ?? ''}
                  className={layout === 'grid' ? 'grid gap-3' : 'flex flex-col gap-1.5'}
                  style={{
                    ...(layout === 'grid' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' } : {}),
                    ...refileStyle(folder),
                  }}
                >
                {items.map((inst) => (
                  <div
                    key={inst.id}
                    data-card-id={inst.id}
                    className="h-full"
                    style={cardStyle(inst.id)}
                  >
                    {(() => {
                      const Item = layout === 'list' ? InstanceRow : InstanceCard
                      return <Item
                      instance={inst}
                      {...(reorderable
                        ? { dragHandle: <DragHandle title="Drag to reorder or re-file" onPointerDown={(e) => beginDrag('card', inst.id, e)} /> }
                        : {})}
                      pnl={pnl[inst.id]}
                      folders={folderNames}
                      onActivate={() => act(inst.id, 'activate')}
                      onDeactivate={() => act(inst.id, 'deactivate')}
                      onDuplicate={() => act(inst.id, 'duplicate')}
                      onDelete={() => remove(inst.id)}
                      onSetFolder={async (name) => {
                        await patchInstanceMeta(inst.id, { folder: name })
                        await refresh()
                      }}
                      onSetIcon={async (emoji) => {
                        await patchInstanceMeta(inst.id, { icon: emoji })
                        await refresh()
                      }}
                    />
                    })()}
                  </div>
                ))}
                </div>
                )}
              </div>
            ))
          })()}
        </div>
      )}
    </div>
  )
}

/** A reorder in flight: what is being carried, how far, and over what. */
/**
 * The pod view: the field itself, the card that follows the pointer, and the
 * panel for whichever whale is selected.
 *
 * The hover card is DOM, not a sprite in the scene — it has to look like every
 * other card on this page, and text drawn into a texture never quite does.
 */
function WhaleLayout({ instances, pnl, hover, selected, onHover, onSelect, onActivate, onDeactivate }: {
  instances: StrategyInstanceView[]
  pnl: Record<string, PnlTotals>
  hover: { id: string; x: number; y: number; w: number; h: number } | null
  selected: string | null
  onHover: (id: string | null, at: { x: number; y: number; w: number; h: number } | null) => void
  onSelect: (id: string | null) => void
  onActivate: (id: string) => void
  onDeactivate: (id: string) => void
}) {
  const byId = new Map(instances.map(i => [i.id, i]))
  const hovered = hover ? byId.get(hover.id) : undefined
  const chosen = selected ? byId.get(selected) : undefined
  const field = useRef<WhaleFieldHandle | null>(null)

  /* Which (monitor, key) pairs the selected instance actually consumes. The
     emit stream is the whole system's firehose; without this every whale would
     light up for traffic it never sees. Until it arrives, nothing fires —
     showing the firehose would be worse than showing nothing. */
  const [scope, setScope] = useState<Array<{ monitor: string; key: string }> | null>(null)
  useEffect(() => {
    setScope(null)
    if (!selected) return
    let gone = false
    void fetch(`/api/instances/${selected}/scope`)
      .then(async (r) => {
        if (r.ok && !gone) setScope(((await r.json()) as { monitors: Array<{ monitor: string; key: string }> }).monitors)
      })
      .catch(() => { /* advisory — no scope simply means no signals */ })
    return () => { gone = true }
  }, [selected])

  /* The A1.3 loop, wired to the two things that already exist.

     A monitor emit is the whale HEARING something: a source pings nearby and
     feeds the brain. A run only makes the brain act when it produced
     instructions — a run that looked and decided to do nothing is the normal
     case for these strategies, and firing the whole decision animation on it
     would claim they trade on every tick. */
  useEffect(() => {
    if (!selected) return
    return subscribeLiveEvents((raw) => {
      const event = raw as LiveEvent
      if (event.type === 'monitor_emit') {
        if (!scope) return
        const heard = scope.some(sc => sc.monitor === event.monitor && (sc.key === '*' || sc.key === event.key))
        if (heard) field.current?.signal()
        return
      }
      if (event.type === 'strategy_run' && event.instanceId === selected) {
        if (event.instructions.length > 0) field.current?.react()
        else field.current?.signal() // it looked, and decided not to act
      }
    })
  }, [selected, scope])

  const data: WhaleDatum[] = instances.map(i => ({
    id: i.id,
    name: i.name,
    strategyId: i.strategyId,
    active: i.active,
    pnl: pnl[i.id]?.net,
    icon: iconFor(i),
  }))

  return (
    <div className="relative mt-4">
      <WhaleField
        instances={data}
        selectedId={selected}
        onHover={onHover}
        onSelect={onSelect}
        handleRef={field}
      />

      {/* Follows the pointer, offset so the cursor never sits on top of it.
          Same glass panel the site's dive scene uses, down to the bubbles —
          this view is quoting that page, so it should quote it exactly. */}
      {hovered && hover && (
        <div
          className={`whale-card ${tone(pnl[hovered.id]?.net)}`}
          /* Kept inside the canvas on both axes. Vertically it is clamped so
             the panel never runs off the bottom edge; horizontally it flips to
             the cursor's left when the dossier is open, so the two never stack.
             CARD_H is the panel's own height with a sparkline in it. */
          style={{
            top: Math.max(8, Math.min(hover.y - 14, hover.h - CARD_H - 8)),
            ...(chosen
              ? { right: 'calc(min(30rem, 46%) + 1rem)' }
              : { left: Math.min(hover.x + 20, Math.max(8, hover.w - CARD_W - 8)) }),
          }}
        >
          <span className="bub b1" /><span className="bub b2" /><span className="bub b3" />
          <span className="bub b4" /><span className="bub b5" /><span className="bub b6" />
          <div className="head">
            <span className="dot" />
            <span className="name">{hovered.name}</span>
          </div>
          <div className="figures">
            <span className="pnl">
              {pnl[hovered.id] ? statMoney(pnl[hovered.id]!.net) : '—'}
            </span>
            <span className="unit">net PnL</span>
          </div>
          <svg viewBox="0 0 220 56" preserveAspectRatio="none" aria-hidden>
            <polyline points={sparkPoints(hovered.id, (pnl[hovered.id]?.net ?? 0) >= 0)} />
          </svg>
          <div className="foot">{hovered.strategyId.split('/').pop()} · {hovered.active ? 'LIVE' : 'STOPPED'}</div>
        </div>
      )}

      {/* The selected whale's dossier. Docked to the right half while the
          close-up holds the left — same split the detail page uses, so moving
          between the two costs no re-reading. */}
      {chosen && (
        <div
          className="absolute right-0 top-0 bottom-0 z-10 flex flex-col"
          style={{
            width: 'min(30rem, 46%)',
            background: 'linear-gradient(270deg, color-mix(in srgb, var(--surface) 96%, transparent) 78%, transparent)',
            borderLeft: '1px solid var(--border)',
          }}
        >
          <div className="flex items-center gap-2 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-lg leading-none">{iconFor(chosen)}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate" title={chosen.name}>{chosen.name}</div>
              <div className="text-xs font-mono truncate" style={{ color: 'var(--accent)' }}>{chosen.strategyId}</div>
            </div>
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: chosen.active ? 'var(--success)' : 'var(--border)' }}
              title={chosen.active ? 'Running' : 'Stopped'}
            />
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="w-6 h-6 rounded-md flex items-center justify-center leading-none shrink-0"
              style={{ color: 'var(--muted)' }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden px-4 py-3 flex flex-col gap-4">
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs" style={{ color: 'var(--muted)' }}>PROFIT AND LOSS</h3>
              <div className="grid grid-cols-2 gap-2">
                <Figure label="Net" value={pnl[chosen.id]?.net} />
                <Figure label="Realized" value={pnl[chosen.id]?.realized} />
                <Figure label="Unrealized" value={pnl[chosen.id]?.unrealized} />
                <Figure label="Funding" value={pnl[chosen.id]?.funding} />
                <Figure label="Fees" value={pnl[chosen.id]?.fees} />
              </div>
            </section>

            {bindingsOf(chosen).length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-xs" style={{ color: 'var(--muted)' }}>ACCOUNTS</h3>
                <div className="flex flex-wrap gap-1.5">
                  {bindingsOf(chosen).map(b => (
                    <span key={b} className="text-xs px-1.5 py-0.5 rounded font-mono"
                      style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                      {b}
                    </span>
                  ))}
                </div>
              </section>
            )}

            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs" style={{ color: 'var(--muted)' }}>PARAMETERS</h3>
              <div className="flex flex-col gap-0.5">
                {paramRows(chosen).map(([k, v]) => (
                  <div key={k} className="flex gap-3 text-xs py-1" style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                    <span className="font-mono shrink-0" style={{ color: 'var(--muted)', minWidth: '9rem' }}>{k}</span>
                    <span className="font-mono min-w-0 break-all" style={{ color: 'var(--foreground)' }}>{v}</span>
                  </div>
                ))}
                {paramRows(chosen).length === 0 && (
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>No parameters set.</span>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs" style={{ color: 'var(--muted)' }}>IDENTITY</h3>
              <div className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{chosen.id}</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                created {new Date(chosen.createdAt).toLocaleString()}
              </div>
            </section>
          </div>

          <div className="shrink-0 flex items-center gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={() => (chosen.active ? onDeactivate : onActivate)(chosen.id)}
              className={`${CTRL} px-3 flex-1`}
              style={chosen.active
                ? { background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }
                : { background: 'var(--accent)', color: '#fff' }}
            >
              {chosen.active ? '■ Stop' : '▶ Activate'}
            </button>
            <Link href={`/instances/${chosen.id}`} className={`${CTRL} px-3 gap-1.5`}
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
              <span className="text-sm leading-none">↗</span>
              Full page
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

/* The hover panel's own footprint, for keeping it inside the canvas. Measured
   rather than computed: it is a fixed layout — name, figure, sparkline, foot. */
const CARD_W = 260
const CARD_H = 190

/** Small segmented control — the same shape as the layout switch beside it. */
function Segmented({ value, onChange, options }: {
  value: string
  onChange: (id: string) => void
  options: ReadonlyArray<{ id: string; label: string }>
}) {
  return (
    <div className="flex rounded-md overflow-hidden shrink-0 h-8" style={{ border: '1px solid var(--border)' }}>
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className="px-2.5 text-xs"
          style={{
            background: value === o.id ? 'var(--accent)' : 'transparent',
            color: value === o.id ? '#fff' : 'var(--muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** One labelled money figure in the dossier. */
function Figure({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
      <div className="text-xs" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="text-sm font-mono" style={{ color: moneyColor(value) }}>
        {value === null || value === undefined ? '—' : statMoney(value)}
      </div>
    </div>
  )
}

const bindingsOf = (i: StrategyInstanceView): string[] =>
  i.credentials
    ? Object.entries(i.credentials).map(([slot, target]) => `${slot} → ${target}`)
    : i.accounts ?? []

/** Base and tunable params, flattened for a two-column read. */
function paramRows(i: StrategyInstanceView): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const group of ['base', 'tunable'] as const) {
    const g = i.params?.[group] as Record<string, unknown> | undefined
    if (!g) continue
    for (const [k, v] of Object.entries(g)) {
      if (v === '' || v === undefined || v === null) continue
      out.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
    }
  }
  return out
}

/** Which way the panel leans: profit green, loss red, no reading violet. */
function tone(v: number | null | undefined): 'up' | 'down' | 'flat' {
  if (v === null || v === undefined) return 'flat'
  return v >= 0 ? 'up' : 'down'
}

/**
 * A shape for the card's sparkline.
 *
 * Derived from the instance id, NOT from real history: the panel appears on
 * hover and has no time to fetch a series, and a flat line would read as "this
 * strategy did nothing". Deterministic per id so the same whale always draws
 * the same curve rather than reshuffling every time you point at it.
 *
 * Decorative — the figure beside it is the real number.
 */
function sparkPoints(seed: string, up: boolean): string {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  const rand = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); return ((h >>> 0) % 1000) / 1000 }
  const n = 26
  const pts: string[] = []
  let y = 34
  for (let i = 0; i < n; i++) {
    y += (rand() - (up ? 0.62 : 0.38)) * 6
    y = Math.max(6, Math.min(50, y))
    pts.push(`${(i / (n - 1)) * 220},${y.toFixed(1)}`)
  }
  return pts.join(' ')
}

/** Folder groups: FOLDERS first (ordered by min sortOrder), ungrouped last; items by sortOrder then age. */
function groupByFolder(instances: StrategyInstanceView[]): Array<{ folder: string | undefined; items: StrategyInstanceView[] }> {
  const byKey = new Map<string | undefined, StrategyInstanceView[]>()
  for (const inst of instances) {
    const key = inst.folder || undefined
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(inst)
  }
  const sortItems = (xs: StrategyInstanceView[]) => [...xs].sort((a, b) =>
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt.localeCompare(b.createdAt))
  const minOrder = (xs: StrategyInstanceView[]) =>
    Math.min(...xs.map(x => x.sortOrder ?? Number.MAX_SAFE_INTEGER))
  const folders = [...byKey.keys()].filter((k): k is string => k !== undefined)
    .sort((a, b) => minOrder(byKey.get(a)!) - minOrder(byKey.get(b)!) || a.localeCompare(b))
  const out: Array<{ folder: string | undefined; items: StrategyInstanceView[] }> = []
  for (const f of folders) out.push({ folder: f, items: sortItems(byKey.get(f)!) })
  if (byKey.has(undefined)) out.push({ folder: undefined, items: sortItems(byKey.get(undefined)!) })
  return out
}

/**
 * Persist the FULL layout after any drag: folder blocks get contiguous
 * sortOrder bands (folderIdx×1000 + position×10, ungrouped last), so folder
 * order derives stably from min member order and every drop is durable.
 */
async function persistLayout(groups: Array<{ folder: string | undefined; items: StrategyInstanceView[] }>): Promise<void> {
  const patches: Array<Promise<void>> = []
  groups.forEach((g, gi) => {
    g.items.forEach((inst, i) => {
      const order = gi * 1000 + i * 10
      if (inst.sortOrder !== order) patches.push(patchInstanceMeta(inst.id, { sortOrder: order }))
    })
  })
  await Promise.all(patches)
}

// ── Instance form (create + edit) ─────────────────────────────────────────────

/** Stringify an instance's saved params into the field-value map the form renders. */
export function fieldValuesFromParams(fields: ParamFieldDef[], params: StrategyInstance['params']): Record<string, string> {
  const out = defaultFieldValues(fields)
  for (const f of fields) {
    const group = (f.group === 'base' ? params?.base : params?.tunable) as Record<string, unknown> | undefined
    const v = group?.[f.name]
    if (v !== undefined) out[f.name] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

function InstanceForm({ initial, onSuccess, onCancel }: {
  initial?: StrategyInstance
  onSuccess: () => void
  onCancel: () => void
}) {
  const [strategies, setStrategies] = useState<StrategyDefinition[]>([])
  const [credentials, setCredentials] = useState<CredentialInfo[]>([])
  const [selectedStrategy, setSelectedStrategy] = useState(initial?.strategyId ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [slotBindings, setSlotBindings] = useState<Record<string, string>>(initial?.credentials ?? {})
  const [credentialTypes, setCredentialTypes] = useState<Array<{ type: string; kinds: string[] }>>([])
  // Account entities — the binding targets for account slots (credential names accepted as legacy fallback)
  const [accounts, setAccounts] = useState<Array<{ name: string; implementation: string; credential?: string; kind?: string; type?: string; status: string }>>([])
  // Per-label LLM slot overrides: { [label]: { model?, credentialName? } }
  const [llmBindings, setLlmBindings] = useState<Record<string, { model?: string; credentialName?: string }>>(initial?.llm ?? {})
  // Generic field values for strategies with paramsFields
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  // JSON fallback for strategies without paramsFields
  const [baseParams, setBaseParams] = useState(initial?.params ? JSON.stringify(initial.params.base ?? {}, null, 2) : '{}')
  const [tunableParams, setTunableParams] = useState(initial?.params ? JSON.stringify(initial.params.tunable ?? {}, null, 2) : '{}')
  const [enabled, setEnabled] = useState(initial ? initial.enabled : true)
  const [baseError, setBaseError] = useState('')
  const [tunableError, setTunableError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // A new instance starts at the choice that determines everything else.
  const [pickerOpen, setPickerOpen] = useState(!initial)

  useEffect(() => {
    void Promise.all([
      fetch('/api/strategies').then((r) => r.json() as Promise<StrategyDefinition[]>),
      fetch('/api/credentials').then((r) => r.json() as Promise<CredentialInfo[]>),
      fetch('/api/credential-types').then((r) => r.json() as Promise<Array<{ type: string; kinds: string[] }>>),
      fetch('/api/accounts').then((r) => r.json() as Promise<{ accounts: Array<{ name: string; implementation: string; credential?: string; kind?: string; type?: string; status: string }> }>),
    ]).then(([s, c, ct, a]) => {
      setStrategies(s)
      setCredentials(c)
      setCredentialTypes(ct)
      setAccounts(a.accounts ?? [])
      if (initial) {
        // Edit mode: the strategy is fixed; prefill fields from the saved params
        const strat = s.find((x) => x.id === initial.strategyId)
        if (strat?.paramsFields) setFieldValues(fieldValuesFromParams(strat.paramsFields, initial.params))
      }
      // No auto-select for a new instance: the picker opens on top and the
      // choice is explicit. Silently pre-selecting whichever strategy sorted
      // first is how you create an instance of something you never read.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id])

  // Reset field values when strategy changes. Re-confirming the SAME strategy
  // from the browser is not a change — it must not discard what you typed.
  function handleStrategyChange(id: string) {
    if (id === selectedStrategy) return
    setSelectedStrategy(id)
    setSlotBindings({})
    const strat = strategies.find((s) => s.id === id)
    if (strat?.paramsFields) {
      setFieldValues(defaultFieldValues(strat.paramsFields))
    } else {
      setFieldValues({})
      setBaseParams('{}')
      setTunableParams('{}')
    }
  }

  function validateJson(value: string, setter: (e: string) => void): boolean {
    try {
      JSON.parse(value)
      setter('')
      return true
    } catch {
      setter('Invalid JSON')
      return false
    }
  }

  function buildParams(): { base: Record<string, unknown>; tunable: Record<string, unknown> } | null {
    const strategy = strategies.find((s) => s.id === selectedStrategy)
    if (strategy?.paramsFields) {
      return buildParamsFromFields(strategy.paramsFields, fieldValues)
    }
    const baseOk = validateJson(baseParams, setBaseError)
    const tunableOk = validateJson(tunableParams, setTunableError)
    if (!baseOk || !tunableOk) return null
    return {
      base: JSON.parse(baseParams) as Record<string, unknown>,
      tunable: JSON.parse(tunableParams) as Record<string, unknown>,
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError('')
    const params = buildParams()
    if (!params) return

    setSubmitting(true)
    const llm = Object.fromEntries(Object.entries(llmBindings)
      .map(([label, b]) => [label, {
        ...(b.model?.trim() ? { model: b.model.trim() } : {}),
        ...(b.credentialName ? { credentialName: b.credentialName } : {}),
      }])
      .filter(([, b]) => Object.keys(b as object).length > 0))

    let res: Response
    if (initial) {
      // Edit: PATCH the stopped instance — every field is fair game
      res = await fetch(`/api/instances/${initial.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          // Optional slots may sit unbound — an empty binding means "not bound"
          credentials: Object.fromEntries(Object.entries(slotBindings).filter(([, v]) => v)),
          llm,
          params,
        }),
      })
    } else {
      const now = new Date().toISOString()
      const payload: StrategyInstance = {
        id: newId('inst'),
        name: name.trim(),
        description: description.trim() || undefined,
        strategyId: selectedStrategy,
        icon: randomIcon(),
        ...(Object.values(slotBindings).some(v => v)
          ? { credentials: Object.fromEntries(Object.entries(slotBindings).filter(([, v]) => v)) }
          : {}),
        ...(Object.keys(llm).length > 0 ? { llm } : {}),
        params,
        enabled,
        createdAt: now,
        updatedAt: now,
      }
      res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    if (res.ok) {
      onSuccess()
    } else {
      const body = await res.text()
      setSubmitError(body || (initial ? 'Failed to save instance' : 'Failed to activate instance'))
    }
    setSubmitting(false)
  }

  const strategy = strategies.find((s) => s.id === selectedStrategy)

  /**
   * Venue implied by the account bindings — what symbol pickers on params
   * query, since strategy params carry no venue field (it derives from the
   * bound account). Takes the first bound slot in declaration order: a
   * strategy that picks symbols has one venue in practice, and the picker is
   * a suggestion anyway — typed symbols always remain valid.
   */
  const boundVenue = (() => {
    for (const slot of strategy?.accountRequirements ?? []) {
      const bound = slotBindings[slot.label]
      if (!bound) continue
      const account = accounts.find((a) => a.name === bound)
      if (account?.type) return account.type
    }
    return undefined
  })()

  // Backing out of the browser returns to the form once a strategy is chosen;
  // with nothing chosen there is no form to return to, so it closes.
  const dismiss = () => {
    if (pickerOpen && selectedStrategy) setPickerOpen(false)
    else onCancel()
  }

  // One Modal across both steps: remounting the shell would restart the
  // scroll lock and flash the panel between choosing and configuring.
  return (
    <Modal
      onClose={dismiss}
      maxWidth="58rem"
      height="min(90vh, calc(100vh - 2rem))"
      maximizable
      persistKey="ow:instance-dialog-maximized"
    >
      {pickerOpen ? (
        <StrategyBrowser
          strategies={strategies}
          selectedId={selectedStrategy}
          onPick={(id) => { handleStrategyChange(id); setPickerOpen(false) }}
          onCancel={dismiss}
          cancelLabel={selectedStrategy ? '← Back' : 'Cancel'}
        />
      ) : (
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        {/* Which strategy this configures stays pinned above the scroll — in a
            forty-parameter form it is the one fact you must not lose track of. */}
        <div className="flex items-start gap-3 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {initial ? `Edit "${initial.name}"` : 'Configure the instance'}
            </div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
              {!initial && 'Step 2 of 2 · '}
              {strategy
                ? <>{strategy.name || strategy.id} <span className="mono">{strategy.id}</span></>
                : initial
                  ? <span className="mono">{initial.strategyId}</span>
                  : 'No strategy chosen'}
            </div>
          </div>
          <ModalMaximizeButton />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {!initial && strategies.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>No strategies registered.</p>
          )}
          {strategy && ((strategy.monitorIds?.length ?? 0) > 0 || (strategy.executorIds?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-2">
              {(strategy.monitorIds?.length ?? 0) > 0 && <Tag label="Monitors" values={strategy.monitorIds ?? []} color="var(--accent)" />}
              {(strategy.executorIds?.length ?? 0) > 0 && <Tag label="Executors" values={strategy.executorIds ?? []} color="var(--warning)" />}
            </div>
          )}

          {/* Name */}
          <FormField label="Name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Copy Trade BTC Leader"
              className="rounded-md px-3 py-2 text-sm w-full"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            />
          </FormField>

          {/* Description */}
          <FormField label="Description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="rounded-md px-3 py-2 text-sm w-full"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            />
          </FormField>

          {/* Account slots — one labeled binding per strategy declaration, eligible ACCOUNTS only */}
          {(strategy?.accountRequirements?.length ?? 0) > 0 && (
            <FormField label="Accounts" hint="Each slot lists the accounts whose kind (and venue, when pinned) matches — create accounts on the Accounts page">
              <div className="flex flex-col gap-2">
                {strategy!.accountRequirements!.map((slot) => {
                  const eligible = accounts.filter(a =>
                    a.status === 'ready' &&
                    (slot.kind === undefined || a.kind === slot.kind) &&
                    (slot.type === undefined || a.type === slot.type),
                  )
                  // Credentials also bind: kind slots as the legacy fallback; kindless
                  // type-pinned slots (raw executor slots) bind credentials DIRECTLY —
                  // that is their only form, so match on the pinned type alone.
                  const typesForKind = new Set(
                    credentialTypes.filter(t => slot.kind && t.kinds.includes(slot.kind!)).map(t => t.type),
                  )
                  const legacyEligible = credentials.filter(c =>
                    (slot.kind ? typesForKind.has(c.type) : slot.type !== undefined) &&
                    (slot.type === undefined || c.type === slot.type),
                  )
                  return (
                    <div key={slot.label} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                      <div className="flex flex-col min-w-32">
                        <span className="text-sm font-mono">{slot.label}</span>
                        <span className="text-xs" style={{ color: 'var(--muted)' }}>{slot.type ?? slot.kind}</span>
                      </div>
                      <select
                        value={slotBindings[slot.label] ?? ''}
                        onChange={(e) => setSlotBindings((prev) => ({ ...prev, [slot.label]: e.target.value }))}
                        required={!slot.optional}
                        className="flex-1 rounded-md px-3 py-2 text-sm"
                        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                      >
                        <option value="">
                          {slot.optional
                            ? 'not bound (optional)'
                            : eligible.length === 0 && legacyEligible.length === 0
                              ? `no eligible account — create a ${slot.type ?? slot.kind} account first`
                              : 'choose account…'}
                        </option>
                        {eligible.length > 0 && (
                          <optgroup label="Accounts">
                            {eligible.map(a => <option key={a.name} value={a.name}>{a.name} ({a.type ?? a.kind})</option>)}
                          </optgroup>
                        )}
                        {legacyEligible.length > 0 && (
                          <optgroup label={slot.kind ? 'Credentials (legacy direct binding)' : 'Credentials'}>
                            {legacyEligible.map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  )
                })}
              </div>
            </FormField>
          )}

          {/* LLM slots — model/credential overrides per declared label */}
          {(strategy?.llmRequirements?.length ?? 0) > 0 && (
            <FormField label="LLM Slots" hint="Override each slot's model or pin a credential; empty fields use the strategy's declared defaults">
              <div className="flex flex-col gap-2">
                {strategy!.llmRequirements!.map((slot) => {
                  const binding = llmBindings[slot.label] ?? {}
                  const provider = (binding.model?.trim() || slot.model).split(':')[0] ?? ''
                  const matching = credentials.filter((c) => c.type === provider)
                  return (
                    <div key={slot.label} className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-md" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                      <span className="text-xs font-mono w-24">{slot.label}</span>
                      <input
                        value={binding.model ?? ''}
                        onChange={(e) => setLlmBindings((prev) => ({ ...prev, [slot.label]: { ...prev[slot.label], model: e.target.value } }))}
                        placeholder={slot.model}
                        className="rounded-md px-2 py-1.5 text-xs font-mono flex-1 min-w-48"
                        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                      />
                      <select
                        value={binding.credentialName ?? ''}
                        onChange={(e) => setLlmBindings((prev) => ({ ...prev, [slot.label]: { ...prev[slot.label], credentialName: e.target.value } }))}
                        className="rounded-md px-2 py-1.5 text-xs"
                        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                      >
                        <option value="">{matching.length > 0 ? 'auto credential' : `no "${provider}" credential`}</option>
                        {matching.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                      </select>
                    </div>
                  )
                })}
              </div>
            </FormField>
          )}

          {/* Params — generic field renderer if paramsFields present, JSON editor otherwise */}
          {strategy?.paramsFields ? (
            <ParamFieldsForm
              fields={strategy.paramsFields}
              values={fieldValues}
              onChange={setFieldValues}
              strategyId={strategy.id}
              venueContext={boundVenue}
              illustrations={strategy.paramsIllustrations}
            />
          ) : (
            <>
              <FormField label="Base Params (JSON)" hint="Required params defined in baseParamsSchema" error={baseError}>
                <JsonEditor
                  value={baseParams}
                  onChange={(v) => { setBaseParams(v); validateJson(v, setBaseError) }}
                  placeholder='{ "symbol": "BTC" }'
                  hasError={!!baseError}
                />
              </FormField>
              <FormField label="Tunable Params (JSON)" hint="Optional — Zod defaults apply for missing fields" error={tunableError}>
                <JsonEditor
                  value={tunableParams}
                  onChange={(v) => { setTunableParams(v); validateJson(v, setTunableError) }}
                  placeholder='{ "threshold": 100000 }'
                  hasError={!!tunableError}
                />
              </FormField>
            </>
          )}

          {/* Enabled toggle — create only; edit saves a stopped instance, resume via Activate */}
          {!initial && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEnabled((v) => !v)}
                className="relative w-10 h-5 rounded-full transition-colors"
                style={{ background: enabled ? 'var(--accent)' : 'var(--border)' }}
                aria-label="Toggle enabled"
              >
                <span
                  className="absolute top-0.5 left-0 w-4 h-4 rounded-full bg-white transition-transform"
                  style={{ transform: enabled ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }}
                />
              </button>
              <span className="text-sm">{enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
          )}
        </div>

        {/* Outside the scroll area: a rejection you have to scroll to find is
            a rejection you will retry blind. */}
        {submitError && (
          <p className="text-sm px-5 py-2 shrink-0" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
            {submitError}
          </p>
        )}

        <div className="flex items-center gap-2 px-5 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
          {/* Wizard navigation sits where a wizard puts it: back on the left,
              commit on the right. Going back keeps everything already filled in. */}
          {!initial && strategies.length > 0 && (
            <button type="button" onClick={() => setPickerOpen(true)} className="btn btn-secondary">
              ← Back
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
          <button
            type="submit"
            disabled={submitting || (!initial && (strategies.length === 0 || !selectedStrategy))}
            className="btn btn-primary"
            style={{ opacity: submitting ? 0.6 : 1 }}
          >
            {initial ? (submitting ? 'Saving…' : 'Save Changes') : (submitting ? 'Activating…' : 'Activate')}
          </button>
        </div>
      </form>
      )}
    </Modal>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FormField({
  label, hint, error, required, children,
}: {
  label: string; hint?: string; error?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
        </label>
        {hint && <span className="text-xs" style={{ color: 'var(--muted)', opacity: 0.6 }}>— {hint}</span>}
      </div>
      {children}
      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}

function JsonEditor({ value, onChange, placeholder, hasError }: {
  value: string; onChange: (v: string) => void; placeholder?: string; hasError: boolean
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      placeholder={placeholder}
      spellCheck={false}
      className="rounded-md px-3 py-2 text-sm font-mono resize-y w-full"
      style={{
        background: 'var(--background)',
        color: 'var(--foreground)',
        border: `1px solid ${hasError ? 'var(--danger)' : 'var(--border)'}`,
      }}
    />
  )
}

function Tag({ label, values, color }: { label: string; values: string[]; color: string }) {
  return (
    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
      {label}:
      {values.map((v) => (
        <span key={v} className="px-1.5 py-0.5 rounded" style={{ background: color + '22', color }}>
          {v}
        </span>
      ))}
    </span>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div
      className="rounded-lg p-10 text-center flex flex-col items-center gap-3"
      style={{ background: 'var(--surface)', border: '1px dashed var(--border)' }}
    >
      <p className="text-sm" style={{ color: 'var(--muted)' }}>No active instances yet.</p>
      <button
        onClick={onNew}
        className="px-4 py-2 rounded-md text-sm"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        + Activate your first strategy
      </button>
    </div>
  )
}

// ── Instance card ─────────────────────────────────────────────────────────────

/** Compact money for a stat cell: the sign carries the colour, the digits stay short. */
function statMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const abs = Math.abs(v)
  const body = abs >= 100_000 ? `${(v / 1_000).toFixed(1)}k`
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return v > 0 ? `+${body}` : body
}

const moneyColor = (v: number | null | undefined): string =>
  v === null || v === undefined ? 'var(--muted)'
    : v > 0.005 ? 'var(--success)' : v < -0.005 ? 'var(--danger)' : 'var(--muted)'

/**
 * The layouts the list can be drawn in.
 *
 * A registry, not a boolean: more are coming, and a boolean would have to be
 * unpicked the moment a third arrives. Adding one is adding a row here plus a
 * branch where the group renders.
 */
/**
 * The drag handle — the only place a drag can start.
 *
 * The whole card used to be the drag surface. On a card that is mostly buttons
 * and numbers that reads as a trap: every press felt like it might pick the
 * card up, so selecting a symbol or reading a figure came with a flinch. A
 * handle makes the grabbable part visible and leaves the rest of the card
 * ordinary.
 *
 * A <span>, not a <button>: beginDrag deliberately ignores presses that land on
 * a control, and it is not a control — nothing happens on click, only on drag.
 */
/**
 * The grip. Dragging starts here and nowhere else.
 *
 * The whole card used to be the handle, which made every click a potential
 * drag — you could not press Activate without the card twitching. Confining it
 * to a grip costs one small icon and buys back the rest of the card.
 *
 * Drawn as six dots in SVG rather than the braille glyph it was before: `⠿`
 * renders at whatever size and weight the text font decides, and in --muted at
 * text-xs it was effectively invisible — a handle nobody can find is the same
 * as no handle. Two columns of three, on currentColor, so it scales and themes
 * with everything else.
 *
 * `touchAction: none` sits on the grip alone: the page still scrolls under a
 * finger everywhere else on the card.
 */
/** One labelled figure in the card's stat row. */
function Stat({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="text-sm font-mono truncate" style={{ color: color ?? 'var(--foreground)' }}>{value}</div>
    </div>
  )
}

/**
 * Everything that is neither "what is this" nor "run it" lives behind the ⋯.
 *
 * Rendered as ONE popup rather than nested menus: a folder picker opened from
 * inside another menu closes its parent the moment you click it (both listen
 * for a click outside themselves), so the sections are inlined here instead.
 */
function CardMenu({ instance, folders, onEdit, onDuplicate, onDelete, onSetFolder }: {
  instance: StrategyInstanceView
  folders: string[]
  onEdit: string
  onDuplicate: () => void
  onDelete: () => void
  onSetFolder?: (name: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <KebabMenu>
      {(close) => (
        <>
          <Link href={onEdit} className={MENU_ITEM} style={{ color: 'var(--foreground)' }}>Edit</Link>
          <button type="button" className={MENU_ITEM} style={{ color: 'var(--foreground)' }}
            onClick={() => { onDuplicate(); close() }}>
            Duplicate
          </button>

          {onSetFolder && (
            <FolderSection current={instance.folder} folders={folders} onPick={onSetFolder} close={close} />
          )}

          {/* Two-step, and only reachable from in here — the old layout put a red
              Delete directly beside Activate, one slip apart from each other. */}
          <button
            type="button"
            className={MENU_ITEM}
            style={{ color: 'var(--danger)', borderTop: '1px solid var(--border)' }}
            onClick={() => {
              if (!confirmDelete) { setConfirmDelete(true); return }
              onDelete(); close(); setConfirmDelete(false)
            }}
          >
            {confirmDelete ? 'Delete for good?' : 'Delete'}
          </button>
        </>
      )}
    </KebabMenu>
  )
}

/**
 * One instance as a card in a grid.
 *
 * The shape follows the reference dashboard: identity at the top (icon, name,
 * a couple of chips), the numbers that matter in a labelled row, and exactly
 * ONE action button at the bottom that states the current state rather than
 * naming a verb — a running instance reads "Running", not "Deactivate".
 * Stopping it is a deliberate second click, which is the point: the old card
 * offered a one-click Deactivate next to a one-click Delete.
 *
 * There is no inline expand any more. It duplicated /instances/[id], which the
 * ↗ and Edit both already open, and a full detail panel unfolding inside one
 * cell of a three-column grid reflows every card beside it.
 */
function InstanceCard({ instance, pnl, folders, dragHandle, onActivate, onDeactivate, onDuplicate, onDelete, onSetFolder, onSetIcon }: {
  instance: StrategyInstanceView
  pnl?: PnlTotals
  folders: string[]
  /** Rendered in the header. Supplied by the list, which owns the drag state. */
  dragHandle?: React.ReactNode
  onActivate: () => void
  onDeactivate: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSetFolder?: (name: string) => void
  onSetIcon?: (emoji: string) => void
}) {
  const base = instance.params?.base ?? {}
  const bindings = instance.credentials
    ? Object.entries(instance.credentials).map(([slot, target]) => `${slot} → ${target}`)
    : instance.accounts ?? []
  // The venue/account chip: the first binding's TARGET is the recognisable half
  const account = bindings[0]?.split('→').pop()?.trim()
  const paramValues = Object.values(base).map(v => String(v)).filter(v => v !== '' && v !== 'false')
  const paramChip = paramValues.slice(0, 2).join(' · ')
  const strategyShort = instance.strategyId.split('/').pop() ?? instance.strategyId

  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-3 h-full"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Identity */}
      <div className="flex items-start gap-3">
        {onSetIcon
          ? <IconMenu current={iconFor(instance)} onPick={onSetIcon}>
              <span className="text-2xl leading-none">{iconFor(instance)}</span>
            </IconMenu>
          : <span className="text-2xl leading-none">{iconFor(instance)}</span>}
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate" title={instance.name}>{instance.name}</div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-xs px-1.5 py-0.5 rounded font-mono truncate"
              style={{ background: 'var(--background)', color: 'var(--accent)', border: '1px solid var(--border)' }}
              title={`${instance.strategyId} · ${instance.id}`}>
              {strategyShort}
            </span>
            {account && (
              <span className="text-xs px-1.5 py-0.5 rounded truncate"
                style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
                title={bindings.join(', ')}>
                {account}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {/* Status is a dot, not a word: it is glanceable across a whole grid */}
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: instance.active ? 'var(--success)' : 'var(--border)' }}
            title={instance.active ? 'Running' : 'Stopped'}
          />
          <CardMenu
            instance={instance}
            folders={folders}
            onEdit={`/instances/${instance.id}`}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            {...(onSetFolder ? { onSetFolder } : {})}
          />
          {/* Last in the row: the grip is the least-used control on the card,
              and putting it at the edge keeps it out of the way of the two
              things that are used — the status dot and the menu. */}
          {dragHandle}
        </div>
      </div>

      {/* The three numbers worth watching. Realized and fees ride along in the
          tooltip — they explain the net, they are not separately actionable. */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="PnL"
          value={pnl ? statMoney(pnl.net) : '—'}
          color={moneyColor(pnl?.net)}
          {...(pnl ? { title: `realized ${pnl.realized.toFixed(2)} · fees ${pnl.fees.toFixed(2)}` } : {})}
        />
        <Stat
          label="Unrealized"
          value={pnl && pnl.unrealized !== null ? statMoney(pnl.unrealized) : '—'}
          color={moneyColor(pnl?.unrealized)}
        />
        <Stat
          label="Funding"
          value={pnl ? statMoney(pnl.funding) : '—'}
          color={moneyColor(pnl?.funding)}
        />
      </div>

      {/* Footer: what it trades, then the one action */}
      <div className="flex items-center gap-2 mt-auto pt-1">
        {paramChip && (
          <span className="text-xs font-mono truncate min-w-0" style={{ color: 'var(--muted)' }}
            title={Object.entries(base).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}>
            {paramChip}
          </span>
        )}
        <div className="ml-auto shrink-0">
          <RunControl instance={instance} onActivate={onActivate} onDeactivate={onDeactivate} />
        </div>
      </div>
    </div>
  )
}

/**
 * Open-the-board link plus the one action: activate, or stop behind a confirm.
 *
 * Extracted because the card and the row both need it, and a duplicated copy of
 * "the button that starts and stops live trading" is the last thing that should
 * be allowed to drift between two layouts.
 */
/* One height for everything in the footer row. These used to be sized by their
   own padding, so the 28px square link sat 2px shorter than its neighbours —
   close enough to look like a mistake rather than a choice. */
const CTRL = 'h-8 rounded-md flex items-center justify-center text-xs shrink-0'

function RunControl({ instance, onActivate, onDeactivate }: {
  instance: StrategyInstanceView
  onActivate: () => void
  onDeactivate: () => void
}) {
  const [confirmStop, setConfirmStop] = useState(false)
  return (
    <div className="flex items-center gap-1.5">
      {/* The board is the most-wanted destination on the card, so it gets a
          real target instead of a glyph in a 28px box. */}
      <Link
        href={`/instances/${instance.id}`}
        className={`${CTRL} px-3 gap-1.5`}
        style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        title="Open the board"
      >
        <span className="text-sm leading-none">↗</span>
        Open
      </Link>
      {instance.active ? (
        confirmStop ? (
          <div className="flex items-center gap-1">
            <button onClick={() => setConfirmStop(false)} className={`${CTRL} px-2.5`}
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
              Cancel
            </button>
            <button onClick={() => { onDeactivate(); setConfirmStop(false) }} className={`${CTRL} px-2.5`}
              style={{ background: 'var(--danger)', color: '#fff' }}>
              Stop
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmStop(true)}
            className={`${CTRL} px-3 gap-1.5`}
            style={{ background: 'color-mix(in srgb, var(--success, #22c55e) 16%, transparent)', color: 'var(--success, #22c55e)', border: '1px solid color-mix(in srgb, var(--success, #22c55e) 40%, transparent)' }}
            title="Running — click to stop it"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success, #22c55e)' }} />
            Running
          </button>
        )
      ) : (
        <button onClick={onActivate} className={`${CTRL} px-3`} style={{ background: 'var(--accent)', color: '#fff' }}>
          ▶ Activate
        </button>
      )}
    </div>
  )
}

/**
 * One instance as a row.
 *
 * Same data and the same sub-components as the card — RunControl, CardMenu,
 * IconMenu, statMoney — laid out horizontally. Nothing here recomputes what the
 * card computes; two layouts that derive their own numbers would eventually
 * disagree, and then the layout switch would look like a data bug.
 *
 * The columns are fixed rather than auto so figures line up down the page. A
 * list whose numbers do not form a column is just a cramped grid.
 */
/**
 * One template for every row, so the columns line up down the whole list.
 *
 * Every track is fixed or fr on purpose. Each row is its own grid, and an
 * `auto` track is sized by THAT row's content — which is exactly why the
 * numbers used to stagger: a longer strategy chip pushed its row's figures
 * right while the row below kept its own. fr resolves against the container,
 * which every row shares.
 *
 * icon · name · chips · pnl · unrealized · funding · params · actions
 */
const ROW_COLUMNS = '1.75rem minmax(0,1.5fr) minmax(0,1.3fr) 5.5rem 5.5rem 5.5rem minmax(0,1.4fr) 15.5rem'

function InstanceRow({ instance, pnl, folders, dragHandle, onActivate, onDeactivate, onDuplicate, onDelete, onSetFolder, onSetIcon }: {
  instance: StrategyInstanceView
  pnl?: PnlTotals
  folders: string[]
  dragHandle?: React.ReactNode
  onActivate: () => void
  onDeactivate: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSetFolder?: (name: string) => void
  onSetIcon?: (emoji: string) => void
}) {
  const base = instance.params?.base ?? {}
  const bindings = instance.credentials
    ? Object.entries(instance.credentials).map(([slot, target]) => `${slot} → ${target}`)
    : instance.accounts ?? []
  const account = bindings[0]?.split('→').pop()?.trim()
  const paramValues = Object.values(base).map(v => String(v)).filter(v => v !== '' && v !== 'false')
  const strategyShort = instance.strategyId.split('/').pop() ?? instance.strategyId

  return (
    <div
      className="rounded-md px-3 py-2 grid items-center gap-3"
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        gridTemplateColumns: ROW_COLUMNS,
      }}
    >
      <div className="flex items-center justify-center">
        {onSetIcon
          ? <IconMenu current={iconFor(instance)} onPick={onSetIcon}>
              <span className="text-lg leading-none">{iconFor(instance)}</span>
            </IconMenu>
          : <span className="text-lg leading-none">{iconFor(instance)}</span>}
      </div>

      <div className="min-w-0 flex items-center gap-2">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: instance.active ? 'var(--success)' : 'var(--border)' }}
          title={instance.active ? 'Running' : 'Stopped'}
        />
        <span className="font-medium text-sm truncate" title={instance.name}>{instance.name}</span>
      </div>

      <div className="min-w-0 flex items-center gap-1.5">
        <span className="text-xs px-1.5 py-0.5 rounded font-mono truncate"
          style={{ background: 'var(--background)', color: 'var(--accent)', border: '1px solid var(--border)' }}
          title={`${instance.strategyId} · ${instance.id}`}>
          {strategyShort}
        </span>
        {account && (
          <span className="text-xs px-1.5 py-0.5 rounded truncate"
            style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
            title={bindings.join(', ')}>
            {account}
          </span>
        )}
      </div>

      {/* Labels ride in the title: a column of repeated "PnL" is noise once the
          header above is gone, but the number still has to say what it is. */}
      <div className="text-xs font-mono text-right truncate" style={{ color: moneyColor(pnl?.net) }}
        title={pnl ? `PnL · realized ${pnl.realized.toFixed(2)} · fees ${pnl.fees.toFixed(2)}` : 'PnL'}>
        {pnl ? statMoney(pnl.net) : '—'}
      </div>
      <div className="text-xs font-mono text-right truncate" style={{ color: moneyColor(pnl?.unrealized) }} title="Unrealized">
        {pnl && pnl.unrealized !== null ? statMoney(pnl.unrealized) : '—'}
      </div>
      <div className="text-xs font-mono text-right truncate" style={{ color: moneyColor(pnl?.funding) }} title="Funding">
        {pnl ? statMoney(pnl.funding) : '—'}
      </div>

      <div className="text-xs font-mono truncate min-w-0" style={{ color: 'var(--muted)' }}
        title={Object.entries(base).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}>
        {paramValues.slice(0, 3).join(' · ')}
      </div>

      <div className="flex items-center justify-end gap-1">
        <RunControl instance={instance} onActivate={onActivate} onDeactivate={onDeactivate} />
        <CardMenu
          instance={instance}
          folders={folders}
          onEdit={`/instances/${instance.id}`}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          {...(onSetFolder ? { onSetFolder } : {})}
        />
        {dragHandle}
      </div>
    </div>
  )
}

/** Inline folder picker — existing folders, a new-folder input, and remove. */
function FolderMenu({ current, folders, onPick }: {
  current?: string
  folders: string[]
  onPick: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const pick = (name: string) => { onPick(name); setOpen(false); setDraft('') }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="px-3 py-1.5 rounded-md text-xs"
        title="Move to a folder"
        style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
      >
        📁{current ? ` ${current}` : ''}
      </button>
      {open && (
        <div
          className="absolute right-0 z-[100] mt-1 rounded-md shadow-lg flex flex-col"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '11rem', maxHeight: '16rem' }}
        >
          <div className="overflow-y-auto">
            {folders.map(f => (
              <button
                key={f}
                type="button"
                onClick={() => pick(f)}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
                style={{ color: 'var(--foreground)' }}
              >
                <span style={{ color: f === current ? 'var(--accent)' : 'var(--muted)' }}>{f === current ? '●' : '○'}</span>
                📁 {f}
              </button>
            ))}
          </div>
          <form
            className="flex gap-1 px-2 py-2"
            style={{ borderTop: folders.length ? '1px solid var(--border)' : 'none' }}
            onSubmit={(e) => { e.preventDefault(); if (draft.trim()) pick(draft.trim()) }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="New folder…"
              className="flex-1 min-w-0 rounded px-2 py-1 text-xs"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            />
            <button type="submit" className="text-xs px-2 rounded" style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}>Add</button>
          </form>
          {current && (
            <button
              type="button"
              onClick={() => pick('')}
              className="text-left px-3 py-1.5 text-xs"
              style={{ color: 'var(--danger)', borderTop: '1px solid var(--border)' }}
            >
              Remove from folder
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Instance detail panel ─────────────────────────────────────────────────────

export function InstanceDetail({ instanceId, tall }: { instanceId: string; tall?: boolean }) {
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([])
  const [executions, setExecutions] = useState<ExecutionResult[]>([])
  const [logs, setLogs] = useState<Array<{ ts: number; level: string; module?: string; msg: string; extra?: Record<string, unknown> }>>([])
  const [activeTab, setActiveTab] = useState<'events' | 'executions' | 'logs' | 'runs'>('events')
  const [runs, setRuns] = useState<RunTrace[]>([])
  const [scope, setScope] = useState<Array<{ monitor: string; key: string }> | null>(null)
  // Runs-tab controls: paused stops polling so an expanded row holds still;
  // the filters cut the every-2s no-op flood down to the runs that acted.
  const [paused, setPaused] = useState(false)
  const [runFilter, setRunFilter] = useState<'all' | 'acted' | 'error'>('all')
  const [runQuery, setRunQuery] = useState('')

  // The instance's event scope: which (monitor, key) pairs it actually
  // consumes. Fetched once; until it arrives, show everything rather than
  // nothing.
  useEffect(() => {
    let gone = false
    void fetch(`/api/instances/${instanceId}/scope`).then(async (r) => {
      if (r.ok && !gone) setScope(((await r.json()) as { monitors: Array<{ monitor: string; key: string }> }).monitors)
    }).catch(() => { /* advisory */ })
    return () => { gone = true }
  }, [instanceId])

  // Shared SSE connection — only this instance's strategy runs, and only
  // monitor emits the instance is subscribed to (the firehose drowns them).
  useEffect(() => {
    return subscribeLiveEvents((data) => {
      const event = data as LiveEvent
      if (event.type !== 'monitor_emit' && event.type !== 'strategy_run') return
      if (event.type === 'strategy_run' && event.instanceId !== instanceId) return
      if (event.type === 'monitor_emit' && scope !== null) {
        const hit = scope.some(s => s.monitor === event.monitor && (s.key === '*' || s.key === event.key))
        if (!hit) return
      }
      setLiveEvents((prev) => [event, ...prev].slice(0, 100))
    })
  }, [instanceId, scope])

  // Run traces poll only while the tab is visible (and not paused).
  useEffect(() => {
    if (activeTab !== 'runs' || paused) return
    let gone = false
    const pull = async () => {
      const r = await fetch(`/api/instances/${instanceId}/runs`)
      if (r.ok && !gone) setRuns(await r.json() as RunTrace[])
    }
    void pull()
    const timer = setInterval(() => void pull(), 5000)
    return () => { gone = true; clearInterval(timer) }
  }, [activeTab, instanceId, paused])

  // Logs poll only while the tab is visible — journald already has them.
  useEffect(() => {
    if (activeTab !== 'logs') return
    let gone = false
    const pull = async () => {
      const r = await fetch(`/api/instances/${instanceId}/logs?n=200`)
      if (r.ok && !gone) setLogs(await r.json() as typeof logs)
    }
    void pull()
    const timer = setInterval(() => void pull(), 3000)
    return () => { gone = true; clearInterval(timer) }
  }, [activeTab, instanceId])

  // Poll executions every 5 s
  const fetchExecutions = useCallback(async () => {
    const res = await fetch(`/api/instances/${instanceId}/executions`)
    if (res.ok) setExecutions(await res.json() as ExecutionResult[])
  }, [instanceId])

  useEffect(() => {
    void fetchExecutions()
    const t = setInterval(() => void fetchExecutions(), 5000)
    return () => clearInterval(t)
  }, [fetchExecutions])

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      {/* Tabs */}
      <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['events', 'executions', 'runs', 'logs'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-4 py-2 text-xs capitalize"
            style={{
              background: activeTab === tab ? 'var(--background)' : 'transparent',
              color: activeTab === tab ? 'var(--foreground)' : 'var(--muted)',
              borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {tab === 'events' ? `Live Events (${liveEvents.length})` : tab === 'executions' ? `Executions (${executions.length})` : tab === 'runs' ? 'Runs' : 'Logs'}
          </button>
        ))}
      </div>

      <div
        className="p-3 overflow-y-auto font-mono text-xs flex flex-col gap-1.5"
        style={{ background: 'var(--background)', maxHeight: tall ? '72vh' : '18rem' }}
      >
        {activeTab === 'events' ? (
          liveEvents.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>Waiting for events…</span>
          ) : (
            liveEvents.map((ev) => (
              <EventRow
                key={ev.type === 'monitor_emit' ? `${ev.ts}:${ev.monitor}:${ev.key}` : `${ev.timestamp}:${ev.triggerId}`}
                event={ev}
              />
            ))
          )
        ) : activeTab === 'executions' ? (
          executions.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>No executions recorded today.</span>
          ) : (
            executions.map((ex, i) => (
              <ExecutionRow key={(ex.instruction as { messageId?: string } | undefined)?.messageId ?? `${ex.executedAt}:${i}`} result={ex} />
            ))
          )
        ) : activeTab === 'runs' ? (
          <>
            <div className="flex gap-2 items-center flex-wrap pb-1" style={{ borderBottom: '1px solid var(--border)' }}>
              {([['all', 'All'], ['acted', 'With instructions'], ['error', 'Errors']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setRunFilter(k)}
                  className="px-2 py-0.5 rounded text-xs"
                  style={{
                    background: runFilter === k ? 'var(--accent)' : 'var(--surface)',
                    color: runFilter === k ? '#fff' : 'var(--muted)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {label}
                </button>
              ))}
              <input
                value={runQuery}
                onChange={(e) => setRunQuery(e.target.value)}
                placeholder="Search step / content…"
                className="px-2 py-0.5 rounded text-xs flex-1 min-w-32"
                style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              />
              <button
                onClick={() => setPaused(p => !p)}
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: paused ? 'var(--warning)' : 'var(--surface)',
                  color: paused ? '#000' : 'var(--muted)',
                  border: '1px solid var(--border)',
                }}
              >
                {paused ? '▶ Paused — click to resume' : '⏸ Pause refresh'}
              </button>
            </div>
            {(() => {
              const q = runQuery.trim().toLowerCase()
              const shown = runs
                .filter(r => runFilter === 'acted' ? r.instructions > 0 : runFilter === 'error' ? r.error !== undefined : true)
                .filter(r => q === '' || JSON.stringify(r).toLowerCase().includes(q))
              return shown.length === 0 ? (
                <span style={{ color: 'var(--muted)' }}>
                  {runs.length === 0
                    ? 'No runs recorded yet. Runs with instructions or errors persist to disk; idle runs are sampled every 10 min.'
                    : `No matching runs (${runs.length} total).`}
                </span>
              ) : (
                shown.map((r) => <RunRow key={`${r.startedAt}:${r.triggerId}`} run={r} />)
              )
            })()}
          </>
        ) : (
          logs.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>No matching log lines yet.</span>
          ) : (
            [...logs].reverse().map((l, i) => <LogRow key={i} row={l} />)
          )
        )}
      </div>
    </div>
  )
}

function EventRow({ event }: { event: LiveEvent }) {
  const [open, setOpen] = useState(false)
  const time = new Date(event.type === 'monitor_emit' ? event.ts : event.timestamp).toLocaleTimeString()

  if (event.type === 'monitor_emit') {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex gap-2 items-start cursor-pointer" onClick={() => setOpen(o => !o)}>
          <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'} {time}</span>
          <span className="px-1 rounded text-xs" style={{ background: 'var(--accent)22', color: 'var(--accent)' }}>monitor</span>
          <a href={`/monitor?sel=${encodeURIComponent(event.monitor)}`} onClick={(e) => e.stopPropagation()}
             className="hover:underline" style={{ color: 'var(--accent)' }}>{event.monitor}</a>
          <span style={{ color: 'var(--foreground)' }}>key={event.key}</span>
          {!open && <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(event.data).slice(0, 80)}</span>}
        </div>
        {open && (
          <pre className="ml-4 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-xs leading-snug"
               style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
            {JSON.stringify(event.data, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex gap-2 items-start cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'} {time}</span>
        <span className="px-1 rounded text-xs" style={{ background: 'var(--warning)22', color: 'var(--warning)' }}>strategy</span>
        <span style={{ color: 'var(--foreground)' }}>triggered</span>
        <span style={{ color: 'var(--muted)' }}>{event.triggerId}</span>
      </div>
      {open && (
        <pre className="ml-4 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-xs leading-snug"
             style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          {JSON.stringify(event.instructions, null, 2)}
        </pre>
      )}
      {event.instructions.length > 0 && (
        <div className="ml-16 flex flex-col gap-0.5">
          {event.instructions.map((ins, i) => (
            <div key={i} className="flex gap-2">
              <span className="px-1 rounded text-xs" style={{ background: 'var(--success)22', color: 'var(--success)' }}>→</span>
              <span style={{ color: 'var(--foreground)' }}>{ins.action}</span>
              <span style={{ color: 'var(--muted)' }}>via {ins.executorId}</span>
              <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(ins.params).slice(0, 60)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ExecutionRow({ result }: { result: ExecutionResult }) {
  const [open, setOpen] = useState(false)
  const time = new Date(result.executedAt).toLocaleTimeString()
  const statusColor = result.status === 'success' ? 'var(--success)' : result.status === 'failed' ? 'var(--danger)' : 'var(--muted)'

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex gap-2 items-start cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'} {time}</span>
        <span className="px-1 rounded text-xs" style={{ background: statusColor + '22', color: statusColor }}>{result.status}</span>
        <span style={{ color: 'var(--foreground)' }}>{result.instruction.action}</span>
        <a href={`/executors`} onClick={(e) => e.stopPropagation()} className="hover:underline"
           style={{ color: 'var(--accent)' }}>via {result.instruction.executorId}</a>
        {result.error && <span className="truncate" style={{ color: 'var(--danger)' }}>{result.error.slice(0, 60)}</span>}
        {!open && <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(result.instruction.params).slice(0, 60)}</span>}
      </div>
      {open && (
        <pre className="ml-4 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto text-xs leading-snug"
             style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  )
}

interface RunTrace {
  startedAt: number
  triggerId: string
  durationMs: number
  instructions: number
  error?: string
  steps: Array<{ ts: number; step: string; data?: Record<string, unknown> }>
}

function RunRow({ run }: { run: RunTrace }) {
  const [open, setOpen] = useState(false)
  const color = run.error ? 'var(--danger)' : run.instructions > 0 ? 'var(--success)' : 'var(--muted)'
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex gap-2 items-start cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'} {new Date(run.startedAt).toLocaleTimeString()}</span>
        <span className="px-1 rounded text-xs" style={{ background: color + '22', color }}>
          {run.error ? 'error' : `${run.instructions} instruction${run.instructions === 1 ? '' : 's'}`}
        </span>
        <span style={{ color: 'var(--muted)' }}>{run.durationMs}ms · {run.steps.length} steps · {run.triggerId}</span>
        {run.error && <span className="truncate" style={{ color: 'var(--danger)' }}>{run.error.slice(0, 60)}</span>}
      </div>
      {open && (
        <div className="ml-4 flex flex-col gap-1 p-2 rounded" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          {run.steps.map((s, i) => <RunStep key={i} step={s} startedAt={run.startedAt} />)}
        </div>
      )}
    </div>
  )
}

function RunStep({ step, startedAt }: { step: { ts: number; step: string; data?: Record<string, unknown> }; startedAt: number }) {
  const [open, setOpen] = useState(false)
  const hasData = step.data && Object.keys(step.data).length > 0
  const kind = step.step.split(':')[0]
  const kindColor = kind === 'leg' ? 'var(--accent)' : kind === 'instruction' ? 'var(--success)' : kind === 'gate' ? 'var(--warning)' : 'var(--muted)'
  return (
    <div className="flex flex-col gap-0.5">
      <div className={hasData ? 'flex gap-2 items-start cursor-pointer' : 'flex gap-2 items-start'}
           onClick={() => hasData && setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{hasData ? (open ? '▾' : '▸') : '·'} +{step.ts - startedAt}ms</span>
        <span style={{ color: kindColor }}>{step.step}</span>
        {!open && hasData && <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(step.data).slice(0, 90)}</span>}
      </div>
      {open && hasData && (
        <pre className="ml-6 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-xs leading-snug"
             style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          {JSON.stringify(step.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function LogRow({ row }: { row: { ts: number; level: string; module?: string; msg: string; extra?: Record<string, unknown> } }) {
  const [open, setOpen] = useState(false)
  const color = row.level === 'error' ? 'var(--danger)' : row.level === 'warn' ? 'var(--warning)' : 'var(--muted)'
  const hasExtra = row.extra && Object.keys(row.extra).length > 0
  return (
    <div className="flex flex-col gap-0.5">
      <div className={hasExtra ? 'flex gap-2 items-start cursor-pointer' : 'flex gap-2 items-start'}
           onClick={() => hasExtra && setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{hasExtra ? (open ? '▾' : '▸') : ' '} {new Date(row.ts).toLocaleTimeString()}</span>
        <span className="px-1 rounded text-xs uppercase" style={{ background: color + '22', color }}>{row.level}</span>
        {row.module && <span style={{ color: 'var(--muted)' }}>{row.module}</span>}
        <span style={{ color: 'var(--foreground)' }}>{row.msg}</span>
      </div>
      {open && hasExtra && (
        <pre className="ml-4 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-xs leading-snug"
             style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          {JSON.stringify(row.extra, null, 2)}
        </pre>
      )}
    </div>
  )
}

