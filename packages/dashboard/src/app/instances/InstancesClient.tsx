'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import type { StrategyInstance, StrategyInstanceView } from '@openwhaleorg/core'
import type { StrategyDefinition, CredentialInfo, ParamFieldDef, ParamIllustration, ExecutionResult } from '@openwhaleorg/core'
import { subscribeLiveEvents } from '@/lib/live-events'
import { SymbolPicker } from '@/components/SymbolPicker'

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
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
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
            className="rounded-md px-3 py-2 text-sm font-mono w-full"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
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
            className="rounded-md px-3 py-2 text-sm flex-1"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
          {/* The unit is half the meaning of a number — 6 what? */}
          {field.unit && <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{field.unit}</span>}
        </div>
        {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
      </div>
    )
  }

  const illsFor = (sec: string) => (illustrations ?? []).filter(i => (i.section ?? '') === sec)

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
          <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Tunable Parameters</label>
          <div className="rounded-md p-3 flex flex-col gap-4" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            {/* Sections in first-appearance order; unsectioned fields group under General. */}
            {[...new Set(tunableFields.map((f) => f.section ?? ''))].map((sec) => (
              <div key={sec || 'general'} className="flex flex-col gap-3">
                {sec !== '' && (
                  <div className="text-[11px] font-semibold uppercase tracking-wider pb-1"
                       style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                    {sec}
                  </div>
                )}
                {tunableFields.filter((f) => (f.section ?? '') === sec).map(renderField)}
                {sec !== '' && illsFor(sec).map((ill, i) => <IllustrationFrame key={`${sec}-${i}`} ill={ill} values={values} />)}
              </div>
            ))}
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

export function InstancesClient({ initialInstances }: Props) {
  const [instances, setInstances] = useState(initialInstances)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<StrategyInstanceView | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/instances')
    if (res.ok) setInstances(await res.json())
    setLoading(false)
  }, [])

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
      <div className="flex justify-end gap-2 mb-4">
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          onClick={() => { setShowForm((v) => !v); setEditing(null) }}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{ background: showForm ? 'var(--surface)' : 'var(--accent)', color: '#fff', border: showForm ? '1px solid var(--border)' : 'none' }}
        >
          {showForm ? 'Cancel' : '+ New Instance'}
        </button>
      </div>

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

      {instances.length === 0 && !showForm ? (
        <EmptyState onNew={() => setShowForm(true)} />
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {(() => {
            const groups = groupByFolder(instances)
            const folderNames = groups.map(g => g.folder).filter((f): f is string => f !== undefined)

            const dropCard = async (dragId: string, targetId: string) => {
              if (dragId === targetId) return
              // Reorder within the drag card's group; dropping onto a card of
              // ANOTHER group moves it there (before the target).
              const next = groups.map(g => ({ ...g, items: [...g.items] }))
              const from = next.find(g => g.items.some(i => i.id === dragId))
              const to = next.find(g => g.items.some(i => i.id === targetId))
              if (!from || !to) return
              const dragged = from.items.splice(from.items.findIndex(i => i.id === dragId), 1)[0]!
              const at = to.items.findIndex(i => i.id === targetId)
              to.items.splice(at, 0, dragged)
              if (from !== to) await patchInstanceMeta(dragId, { folder: to.folder ?? '' })
              await persistLayout(next)
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

            return groups.map(({ folder, items }) => (
              <div key={folder ?? '·'} className="flex flex-col gap-3">
                {folder !== undefined && (
                  <div
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('ow/folder', folder); e.dataTransfer.effectAllowed = 'move' }}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('ow/folder')) e.preventDefault() }}
                    onDrop={(e) => {
                      const dragged = e.dataTransfer.getData('ow/folder')
                      if (dragged) { e.preventDefault(); void dropFolder(dragged, folder) }
                    }}
                    className="flex items-center gap-2 mt-2 cursor-grab select-none"
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
                    <span className="text-xs" style={{ color: 'var(--muted)' }} title="Drag to reorder folders">⠿</span>
                  </div>
                )}
                {folder === undefined && groups.length > 1 && (
                  <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Ungrouped</div>
                )}
                {(folder === undefined || !collapsedFolders.has(folder)) && items.map((inst) => (
                  <div
                    key={inst.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('ow/card', inst.id); e.dataTransfer.effectAllowed = 'move' }}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('ow/card')) e.preventDefault() }}
                    onDrop={(e) => {
                      const dragged = e.dataTransfer.getData('ow/card')
                      if (dragged) { e.preventDefault(); void dropCard(dragged, inst.id) }
                    }}
                  >
                    <InstanceCard
                      instance={inst}
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
                  </div>
                ))}
              </div>
            ))
          })()}
        </div>
      )}
    </div>
  )
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
      } else if (s.length > 0) {
        const first = s[0]!
        setSelectedStrategy(first.id)
        if (first.paramsFields) setFieldValues(defaultFieldValues(first.paramsFields))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id])

  // Reset field values when strategy changes
  function handleStrategyChange(id: string) {
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
          credentials: slotBindings,
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
        ...(Object.keys(slotBindings).length > 0 ? { credentials: slotBindings } : {}),
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

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg p-5 mb-2 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold text-base">{initial ? `Edit "${initial.name}"` : 'New Strategy Instance'}</h2>

      {/* Strategy selector — fixed in edit mode */}
      <FormField label="Strategy" required>
        {initial ? (
          <p className="text-sm font-mono px-3 py-2 rounded-md" style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--accent)' }}>
            {initial.strategyId}
          </p>
        ) : strategies.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No strategies registered.</p>
        ) : (
          <select
            value={selectedStrategy}
            onChange={(e) => handleStrategyChange(e.target.value)}
            required
            className="rounded-md px-3 py-2 text-sm w-full"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}{s.description ? ` — ${s.description}` : ''}
              </option>
            ))}
          </select>
        )}
        {strategy && (
          <div className="flex flex-wrap gap-2 mt-1">
            {(strategy.monitorIds?.length ?? 0) > 0 && <Tag label="Monitors" values={strategy.monitorIds ?? []} color="var(--accent)" />}
            {(strategy.executorIds?.length ?? 0) > 0 && <Tag label="Executors" values={strategy.executorIds ?? []} color="var(--warning)" />}
          </div>
        )}
      </FormField>

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
              // Legacy fallback: bare credentials still bind (kind's canonical reader)
              const typesForKind = new Set(
                credentialTypes.filter(t => slot.kind && t.kinds.includes(slot.kind!)).map(t => t.type),
              )
              const legacyEligible = credentials.filter(c =>
                typesForKind.has(c.type) && (slot.type === undefined || c.type === slot.type),
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
                    required
                    className="flex-1 rounded-md px-3 py-2 text-sm"
                    style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  >
                    <option value="">
                      {eligible.length === 0 && legacyEligible.length === 0
                        ? `no eligible account — create a ${slot.type ?? slot.kind} account first`
                        : 'choose account…'}
                    </option>
                    {eligible.length > 0 && (
                      <optgroup label="Accounts">
                        {eligible.map(a => <option key={a.name} value={a.name}>{a.name} ({a.type ?? a.kind})</option>)}
                      </optgroup>
                    )}
                    {legacyEligible.length > 0 && (
                      <optgroup label="Credentials (legacy direct binding)">
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

      {submitError && (
        <p className="text-sm px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || (!initial && strategies.length === 0)}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: submitting ? 0.6 : 1 }}
        >
          {initial ? (submitting ? 'Saving…' : 'Save Changes') : (submitting ? 'Activating…' : 'Activate')}
        </button>
      </div>
    </form>
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

function InstanceCard({ instance, folders, onActivate, onDeactivate, onDuplicate, onDelete, onSetFolder, onSetIcon }: {
  instance: StrategyInstanceView
  folders: string[]
  onActivate: () => void
  onDeactivate: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSetFolder?: (name: string) => void
  onSetIcon?: (emoji: string) => void
}) {
  const [confirming, setConfirming] = useState<'deactivate' | 'delete' | null>(null)
  const [expanded, setExpanded] = useState(false)
  const base = instance.params?.base ?? {}
  const bindings = instance.credentials
    ? Object.entries(instance.credentials).map(([slot, target]) => `${slot} → ${target}`)
    : instance.accounts ?? []

  const smallButton = (label: string, onClick: () => void, style: React.CSSProperties) => (
    <button onClick={onClick} className="px-3 py-1.5 rounded-md text-xs" style={style}>{label}</button>
  )

  return (
    <div
      className="rounded-lg"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', opacity: instance.active ? 1 : 0.85 }}
    >
      {/* Header row */}
      <div className="p-4 flex items-start justify-between gap-4">
        <button
          className="flex flex-col gap-1 min-w-0 text-left flex-1"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-center gap-2 flex-wrap">
            {onSetIcon
              ? <IconMenu current={iconFor(instance)} onPick={onSetIcon}>
                  <span className="text-lg leading-none">{iconFor(instance)}</span>
                </IconMenu>
              : <span className="text-lg leading-none">{iconFor(instance)}</span>}
            <span className="font-medium truncate">{instance.name}</span>
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{
                background: instance.active ? '#14532d' : '#292524',
                color: instance.active ? 'var(--success)' : 'var(--muted)',
              }}
            >
              {instance.active ? 'active' : 'stopped'}
            </span>
            <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>
              {expanded ? '▲' : '▼'}
            </span>
          </div>
          {instance.description && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{instance.description}</span>
          )}
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            strategy: <span style={{ color: 'var(--accent)' }}>{instance.strategyId}</span>
            {' · '}id: {instance.id}
          </span>
          {bindings.length > 0 && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              accounts: {bindings.join(', ')}
            </span>
          )}
          {Object.keys(base).length > 0 && (
            <div className="flex flex-wrap gap-3 mt-1">
              {Object.entries(base).map(([key, value]) => (
                <ParamBadge
                  key={key}
                  label={key}
                  value={typeof value === 'string' && value.length > 14 ? value.slice(0, 12) + '…' : String(value)}
                />
              ))}
            </div>
          )}
        </button>

        <div className="shrink-0 flex gap-2 flex-wrap justify-end">
          {onSetFolder && <FolderMenu current={instance.folder} folders={folders} onPick={onSetFolder} />}
          <Link
            href={`/instances/${instance.id}`}
            className="px-3 py-1.5 rounded-md text-xs"
            style={{ background: 'var(--background)', color: 'var(--accent)', border: '1px solid var(--border)' }}
          >
            Board ↗
          </Link>
          {confirming ? (
            <>
              <span className="text-xs self-center" style={{ color: 'var(--muted)' }}>
                {confirming === 'delete' ? 'Delete for good?' : 'Stop this instance?'}
              </span>
              {smallButton('Cancel', () => setConfirming(null),
                { background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' })}
              {smallButton('Confirm', () => { (confirming === 'delete' ? onDelete : onDeactivate)(); setConfirming(null) },
                { background: 'var(--danger)', color: '#fff' })}
            </>
          ) : instance.active ? (
            <>
              {smallButton('Duplicate', onDuplicate,
                { background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' })}
              {smallButton('Deactivate', () => setConfirming('deactivate'),
                { background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' })}
            </>
          ) : (
            <>
              {smallButton('Activate', onActivate,
                { background: 'var(--accent)', color: '#fff' })}
              <Link
                href={`/instances/${instance.id}`}
                className="px-3 py-1.5 rounded-md text-xs"
                style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              >
                Edit
              </Link>
              {smallButton('Duplicate', onDuplicate,
                { background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' })}
              {smallButton('Delete', () => setConfirming('delete'),
                { background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' })}
            </>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {expanded && <div className="rounded-b-lg overflow-hidden"><InstanceDetail instanceId={instance.id} /></div>}
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

function ParamBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
      {label}:
      <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
        {value}
      </span>
    </span>
  )
}
