'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
                className="text-[11px] px-2 py-0.5 rounded-md"
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
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--foreground)' }}>
                      {sec || 'General'}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{fieldsIn(sec).length}</span>
                    {/* A collapsed group must still say whether anything inside it was touched. */}
                    {edited > 0 && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full"
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

  /* Reordering is POINTER-based, not HTML5 drag-and-drop.
     The native API paints a translucent CLONE of the element and gives no
     control over it: what follows the cursor is a picture, while the card you
     grabbed sits untouched in the grid. Here the real element is translated,
     so the thing moving is the thing you picked up.
     `pointer-events: none` on the dragged card is what lets elementFromPoint
     see the card UNDER the cursor rather than the one being carried. */
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  /* The drop handlers close over `groups`, which is computed inside the render
     below — so they are published here each render and read at pointer-up. */
  const [layout, setLayout] = useLayout()
  const dropRef = useRef<{ card: (a: string, b: string) => void; folder: (a: string, b: string) => void }>({ card: () => {}, folder: () => {} })

  const beginDrag = (kind: 'card' | 'folder', id: string, e: React.PointerEvent) => {
    // Left button only, and never from a control: a card is mostly buttons.
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return
    const startX = e.clientX
    const startY = e.clientY
    const attr = kind === 'card' ? 'data-card-id' : 'data-folder-id'
    const box = (e.currentTarget as HTMLElement).closest(`[${attr}]`)?.getBoundingClientRect()
    const rect = box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined
    let started = false

    const publish = (d: DragState | null) => { dragRef.current = d; setDrag(d) }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      // A few pixels of slop, so a click on the card body stays a click
      if (!started && Math.hypot(dx, dy) < 5) return
      if (!started) { started = true; document.body.style.userSelect = 'none' }
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`[${attr}]`)
      const over = el?.getAttribute(attr) ?? null
      publish({ kind, id, dx, dy, over: over === id ? null : over, ...(rect ? { rect } : {}) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      const over = dragRef.current?.over
      publish(null)
      if (started && over) (kind === 'card' ? dropRef.current.card : dropRef.current.folder)(id, over)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** The element being carried, and the one it is hovering over. */
  const dragStyle = (kind: 'card' | 'folder', id: string): React.CSSProperties => {
    if (drag?.kind !== kind) return {}
    if (drag.id === id) {
      // Out of the flow and pinned to where it started, so the reflow behind it
      // cannot drag it off the cursor.
      if (drag.rect) {
        return {
          position: 'fixed',
          left: drag.rect.left + drag.dx,
          top: drag.rect.top + drag.dy,
          width: drag.rect.width,
          zIndex: 50, pointerEvents: 'none',
          cursor: 'grabbing', boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
          transform: 'rotate(1.2deg)',
        }
      }
      return {
        transform: `translate(${drag.dx}px, ${drag.dy}px)`,
        position: 'relative', zIndex: 50, pointerEvents: 'none',
        cursor: 'grabbing', boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
      }
    }
    // No outline on the target any more. The gap that opened where the card
    // would land says it better than a dashed box around a neighbour did —
    // that box only ever said "something is happening near this card".
    return {}
  }

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
        <div className="flex items-center gap-3 mt-4">
          <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
            drag the ⠿ grip to reorder or re-file
          </span>
          <LayoutSwitch value={layout} onChange={setLayout} />
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

      {instances.length === 0 ? (
        <EmptyState onNew={() => setShowForm(true)} />
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {(() => {
            const groups = groupByFolder(instances)
            const folderNames = groups.map(g => g.folder).filter((f): f is string => f !== undefined)

            /**
             * Where everything sits if the card is dropped on the target.
             *
             * The same function drives the live preview and the commit, so what
             * you watch slide into place is exactly what gets saved — a preview
             * computed separately from the commit is a preview that eventually
             * lies about the result.
             */
            const reordered = (dragId: string, targetId: string) => {
              const next = groups.map(g => ({ ...g, items: [...g.items] }))
              const from = next.find(g => g.items.some(i => i.id === dragId))
              const to = next.find(g => g.items.some(i => i.id === targetId))
              if (!from || !to) return undefined
              const dragged = from.items.splice(from.items.findIndex(i => i.id === dragId), 1)[0]!
              to.items.splice(to.items.findIndex(i => i.id === targetId), 0, dragged)
              return { next, moved: from !== to ? to.folder ?? '' : undefined }
            }

            const dropCard = async (dragId: string, targetId: string) => {
              if (dragId === targetId) return
              const plan = reordered(dragId, targetId)
              if (!plan) return
              if (plan.moved !== undefined) await patchInstanceMeta(dragId, { folder: plan.moved })
              await persistLayout(plan.next)
              await refresh()
            }

            dropRef.current = {
              card: (a, b) => { void dropCard(a, b) },
              folder: (a, b) => { void dropFolder(a, b) },
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

            // While a card is over a target, draw the arrangement it would land
            // in. The gap that opens is the drop indicator.
            const preview = drag?.kind === 'card' && drag.over
              ? reordered(drag.id, drag.over)?.next ?? groups
              : groups

            return preview.map(({ folder, items }) => (
              <div key={folder ?? '·'} className="flex flex-col gap-3">
                {folder !== undefined && (
                  <div
                    data-folder-id={folder}
                    className="flex items-center gap-2 mt-2 select-none"
                    style={dragStyle('folder', folder)}
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
                    <DragHandle title="Drag to reorder folders" onPointerDown={(e) => beginDrag('folder', folder, e)} />
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
                  className={layout === 'grid' ? 'grid gap-3' : 'flex flex-col gap-1.5'}
                  style={layout === 'grid' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' } : undefined}
                >
                {items.map((inst) => (
                  <Slide
                    key={inst.id}
                    {...(drag?.kind === 'card' && drag.id === inst.id && drag.rect
                      ? { hole: drag.rect.height }
                      : {})}
                  >
                  <div
                    data-card-id={inst.id}
                    style={dragStyle('card', inst.id)}
                  >
                    {(() => {
                      const Item = layout === 'list' ? InstanceRow : InstanceCard
                      return <Item
                      instance={inst}
                      dragHandle={<DragHandle title="Drag to reorder or re-file" onPointerDown={(e) => beginDrag('card', inst.id, e)} />}
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
                  </Slide>
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
interface DragState {
  kind: 'card' | 'folder'
  id: string
  dx: number
  dy: number
  /** The id under the cursor — where it would land. */
  over: string | null
  /**
   * Where the element sat on screen when the drag began.
   *
   * Load-bearing: while dragging, the others reflow to open a gap, which would
   * move the dragged element's own base position too — and a translate measured
   * from the pointer would then drift away from the cursor by exactly however
   * far the reflow pushed it. Pinning it to this rect takes it out of the flow
   * entirely, so reordering underneath cannot touch it.
   */
  rect?: { left: number; top: number; width: number; height: number }
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
 * Animates its own position changes — this is the "others step aside" part.
 *
 * `hole` is the slot the carried card left behind. Pinning that card with
 * position:fixed takes it out of the flow, which collapses its slot — so the
 * layout would close up instead of opening a gap, and there would be nothing to
 * show where the drop lands. Holding the slot at its old height turns the
 * absence into the drop indicator, and because the slot is the same DOM node it
 * glides to each new target along with everything else.
 *
 * FLIP: after every render, compare where this element is now with where it was
 * last time. If it moved, put it back with a transform and let a transition
 * carry it to the new place. The browser never animates a grid or flex reflow on
 * its own, so without this the neighbours would teleport into their new slots.
 *
 * `still` is for the element being carried — it is pinned to the cursor and must
 * not have a second transform fighting for the same property.
 */
function Slide({ children, hole }: { children: React.ReactNode; hole?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const prev = useRef<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const now = el.getBoundingClientRect()
    const was = prev.current
    prev.current = { left: now.left, top: now.top }
    if (!was) return
    const dx = was.left - now.left
    const dy = was.top - now.top
    // Sub-pixel drift is not a move; animating it just adds jitter
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    // Two frames: one to land the starting transform, one to release it
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)'
        el.style.transform = ''
      })
    })
  })

  return (
    <div
      ref={ref}
      style={hole === undefined ? undefined : {
        height: hole,
        borderRadius: '0.5rem',
        border: '1px dashed color-mix(in srgb, var(--accent) 55%, transparent)',
        background: 'color-mix(in srgb, var(--accent) 7%, transparent)',
      }}
    >
      {children}
    </div>
  )
}

/**
 * The layouts the list can be drawn in.
 *
 * A registry, not a boolean: more are coming, and a boolean would have to be
 * unpicked the moment a third arrives. Adding one is adding a row here plus a
 * branch where the group renders.
 */
const LAYOUTS = [
  { id: 'grid', label: 'Grid', glyph: '▦', hint: 'Cards in a grid' },
  { id: 'list', label: 'List', glyph: '☰', hint: 'One row per instance' },
] as const

type LayoutId = typeof LAYOUTS[number]['id']

const LAYOUT_KEY = 'ow:instances-layout'

/**
 * Which layout to draw, remembered across visits.
 *
 * localStorage rather than the server: this is one operator's viewing
 * preference, not a property of the instances. It also has to survive a reload
 * without a round trip, and the initial read is deliberately lazy — reading
 * storage during render would break SSR hydration.
 */
function useLayout(): [LayoutId, (id: LayoutId) => void] {
  const [layout, setLayout] = useState<LayoutId>('grid')
  useEffect(() => {
    const saved = window.localStorage.getItem(LAYOUT_KEY)
    if (LAYOUTS.some(l => l.id === saved)) setLayout(saved as LayoutId)
  }, [])
  const choose = (id: LayoutId) => {
    setLayout(id)
    try { window.localStorage.setItem(LAYOUT_KEY, id) } catch { /* private mode — the choice just will not stick */ }
  }
  return [layout, choose]
}

/** Segmented control: one button per registered layout. */
function LayoutSwitch({ value, onChange }: { value: LayoutId; onChange: (id: LayoutId) => void }) {
  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {LAYOUTS.map(l => (
        <button
          key={l.id}
          onClick={() => onChange(l.id)}
          title={l.hint}
          aria-pressed={value === l.id}
          className="px-2 py-1 text-xs flex items-center gap-1.5"
          style={{
            background: value === l.id ? 'var(--accent)' : 'transparent',
            color: value === l.id ? '#fff' : 'var(--muted)',
          }}
        >
          <span aria-hidden>{l.glyph}</span>{l.label}
        </button>
      ))}
    </div>
  )
}

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
function DragHandle({ onPointerDown, title }: {
  onPointerDown: (e: React.PointerEvent) => void
  title: string
}) {
  return (
    <span
      onPointerDown={onPointerDown}
      title={title}
      className="drag-grip cursor-grab select-none inline-flex items-center justify-center"
      style={{ width: 18, height: 20, color: 'var(--muted)', touchAction: 'none' }}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden>
        <circle cx="2" cy="3" r="1.35" /><circle cx="8" cy="3" r="1.35" />
        <circle cx="2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" />
        <circle cx="2" cy="13" r="1.35" /><circle cx="8" cy="13" r="1.35" />
      </svg>
    </span>
  )
}

/** One labelled figure in the card's stat row. */
function Stat({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] truncate" style={{ color: 'var(--muted)' }}>{label}</div>
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
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) { setOpen(false); setConfirmDelete(false) }
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const item = 'w-full text-left px-3 py-1.5 text-xs'

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-6 h-6 rounded-md flex items-center justify-center leading-none"
        style={{ color: 'var(--muted)' }}
        title="More"
        aria-label="More actions"
      >
        ⋯
      </button>
      {open && (
        <div
          className="absolute right-0 z-[100] mt-1 rounded-md shadow-lg flex flex-col py-1"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '12rem' }}
        >
          <Link href={onEdit} className={item} style={{ color: 'var(--foreground)' }}>Edit</Link>
          <button type="button" className={item} style={{ color: 'var(--foreground)' }}
            onClick={() => { onDuplicate(); setOpen(false) }}>
            Duplicate
          </button>

          {onSetFolder && (
            <>
              <div className="px-3 pt-2 pb-1 text-[10px]" style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>FOLDER</div>
              {folders.map(f => (
                <button key={f} type="button" className={`${item} flex items-center gap-2`} style={{ color: 'var(--foreground)' }}
                  onClick={() => { onSetFolder(f); setOpen(false) }}>
                  <span style={{ color: f === instance.folder ? 'var(--accent)' : 'var(--muted)' }}>{f === instance.folder ? '●' : '○'}</span>
                  📁 {f}
                </button>
              ))}
              {instance.folder && (
                <button type="button" className={item} style={{ color: 'var(--muted)' }}
                  onClick={() => { onSetFolder(''); setOpen(false) }}>
                  Remove from folder
                </button>
              )}
              <form className="flex gap-1 px-2 py-1"
                onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onSetFolder(draft.trim()); setDraft(''); setOpen(false) } }}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New folder…"
                  className="flex-1 min-w-0 rounded px-2 py-1 text-xs"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                <button type="submit" className="text-xs px-2 rounded" style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}>Add</button>
              </form>
            </>
          )}

          {/* Two-step, and only reachable from in here — the old layout put a red
              Delete directly beside Activate, one slip apart from each other. */}
          <button
            type="button"
            className={item}
            style={{ color: 'var(--danger)', borderTop: '1px solid var(--border)' }}
            onClick={() => {
              if (!confirmDelete) { setConfirmDelete(true); return }
              onDelete(); setOpen(false); setConfirmDelete(false)
            }}
          >
            {confirmDelete ? 'Delete for good?' : 'Delete'}
          </button>
        </div>
      )}
    </div>
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
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono truncate"
              style={{ background: 'var(--background)', color: 'var(--accent)', border: '1px solid var(--border)' }}
              title={`${instance.strategyId} · ${instance.id}`}>
              {strategyShort}
            </span>
            {account && (
              <span className="text-[10px] px-1.5 py-0.5 rounded truncate"
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
          <span className="text-[10px] font-mono truncate min-w-0" style={{ color: 'var(--muted)' }}
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
function RunControl({ instance, onActivate, onDeactivate }: {
  instance: StrategyInstanceView
  onActivate: () => void
  onDeactivate: () => void
}) {
  const [confirmStop, setConfirmStop] = useState(false)
  return (
    <div className="flex items-center gap-1.5">
      <Link
        href={`/instances/${instance.id}`}
        className="w-7 h-7 rounded-md flex items-center justify-center text-xs"
        style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
        title="Open the board"
      >
        ↗
      </Link>
      {instance.active ? (
        confirmStop ? (
          <div className="flex items-center gap-1">
            <button onClick={() => setConfirmStop(false)} className="px-2 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
              Cancel
            </button>
            <button onClick={() => { onDeactivate(); setConfirmStop(false) }} className="px-2 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--danger)', color: '#fff' }}>
              Stop
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmStop(true)}
            className="px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5"
            style={{ background: 'color-mix(in srgb, var(--success, #22c55e) 16%, transparent)', color: 'var(--success, #22c55e)', border: '1px solid color-mix(in srgb, var(--success, #22c55e) 40%, transparent)' }}
            title="Running — click to stop it"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success, #22c55e)' }} />
            Running
          </button>
        )
      ) : (
        <button onClick={onActivate} className="px-3 py-1.5 rounded-md text-xs" style={{ background: 'var(--accent)', color: '#fff' }}>
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
        gridTemplateColumns: 'auto minmax(9rem,1.4fr) minmax(7rem,auto) 5.5rem 5.5rem 5.5rem minmax(0,1fr) auto',
      }}
    >
      {onSetIcon
        ? <IconMenu current={iconFor(instance)} onPick={onSetIcon}>
            <span className="text-lg leading-none">{iconFor(instance)}</span>
          </IconMenu>
        : <span className="text-lg leading-none">{iconFor(instance)}</span>}

      <div className="min-w-0 flex items-center gap-2">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: instance.active ? 'var(--success)' : 'var(--border)' }}
          title={instance.active ? 'Running' : 'Stopped'}
        />
        <span className="font-medium text-sm truncate" title={instance.name}>{instance.name}</span>
      </div>

      <div className="min-w-0 flex items-center gap-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono truncate"
          style={{ background: 'var(--background)', color: 'var(--accent)', border: '1px solid var(--border)' }}
          title={`${instance.strategyId} · ${instance.id}`}>
          {strategyShort}
        </span>
        {account && (
          <span className="text-[10px] px-1.5 py-0.5 rounded truncate"
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

      <div className="text-[10px] font-mono truncate min-w-0" style={{ color: 'var(--muted)' }}
        title={Object.entries(base).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}>
        {paramValues.slice(0, 3).join(' · ')}
      </div>

      <div className="shrink-0 flex items-center gap-1">
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
          <pre className="ml-4 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-[11px] leading-snug"
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
        <pre className="ml-4 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-[11px] leading-snug"
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
        <pre className="ml-4 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto text-[11px] leading-snug"
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
        <pre className="ml-6 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-[11px] leading-snug"
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
        <pre className="ml-4 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-[11px] leading-snug"
             style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          {JSON.stringify(row.extra, null, 2)}
        </pre>
      )}
    </div>
  )
}

