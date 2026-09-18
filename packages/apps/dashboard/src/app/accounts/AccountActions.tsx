'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccountActionInfo, ParamFieldDef } from '@/lib/core-types'
import { SymbolPicker } from '@/components/SymbolPicker'
import { useT } from '@/i18n'

/** Localized on the wire — the gateway resolved every Text to the reader's locale. */
type Action = AccountActionInfo

type Values = Record<string, string>

/** Seed a form from the schema's defaults so a click-to-send action needs no typing. */
function seed(fields: ParamFieldDef[] | undefined): Values {
  const out: Values = {}
  for (const f of fields ?? []) out[f.name] = f.default === undefined ? '' : String(f.default)
  return out
}

/** `displayOptions.show/hide` against the sibling values currently in the form. */
function visible(field: ParamFieldDef, values: Values): boolean {
  const show = field.displayOptions?.show
  const hide = field.displayOptions?.hide
  if (show && !Object.entries(show).every(([k, allowed]) => allowed.some(v => String(v) === (values[k] ?? '')))) return false
  if (hide && Object.entries(hide).some(([k, banned]) => banned.some(v => String(v) === (values[k] ?? '')))) return false
  return true
}

/**
 * Strings in, typed params out — the form only ever holds text, and the schema
 * on the server is what actually validates. An empty optional field is dropped
 * rather than sent as '', which a zod optional would reject.
 */
function toParams(fields: ParamFieldDef[] | undefined, values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields ?? []) {
    if (!visible(f, values)) continue
    const raw = values[f.name] ?? ''
    if (raw === '') continue
    if (f.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) out[f.name] = n
      continue
    }
    if (f.type === 'boolean') { out[f.name] = raw === 'true'; continue }
    out[f.name] = raw
  }
  return out
}

function Field({ field, value, venue, onChange }: {
  field: ParamFieldDef
  value: string
  venue: string | undefined
  onChange: (v: string) => void
}) {
  const input = 'rounded-md px-2 py-1.5 text-sm'
  const inputStyle = { background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' } as const
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }}>
      <span>
        {field.displayName ?? field.name}
        {field.unit && <span>（{field.unit}）</span>}
        {field.description && <span title={field.description}> ⓘ</span>}
      </span>
      {field.catalogue ? (
        <SymbolPicker
          value={value}
          onChange={onChange}
          venue={venue}
          catalogue={field.catalogue}
          className={`${input} font-mono`}
          style={inputStyle}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
        />
      ) : field.type === 'options' && field.options ? (
        <select value={value} onChange={e => onChange(e.target.value)} className={`${input} font-mono`} style={inputStyle}>
          {/* Optional fields need a way back to "unset" — a select with no empty row traps the first option. */}
          {!field.required && <option value=""></option>}
          {field.options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      ) : field.type === 'boolean' ? (
        <select value={value || 'false'} onChange={e => onChange(e.target.value)} className={input} style={inputStyle}>
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      ) : field.slider && field.type === 'number' ? (
        <span className="flex items-center gap-2">
          <input
            type="range"
            min={field.slider.min} max={field.slider.max} step={field.slider.step ?? 1}
            value={value === '' ? String(field.slider.min) : value}
            onChange={e => onChange(e.target.value)}
            className="flex-1"
          />
          <input
            type="number"
            value={value}
            onChange={e => onChange(e.target.value)}
            className={`${input} font-mono w-24`}
            style={inputStyle}
          />
        </span>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
          className={`${input} font-mono`}
          style={inputStyle}
        />
      )}
    </label>
  )
}

/**
 * The write half of the account panel — the counterpart to the read sections.
 *
 * Every widget here is driven by what the implementation DECLARED: the action
 * list, its grouping, its form fields, which of them are dangerous. The page
 * knows nothing about perps or spot, so a new kind gains a trading UI by
 * shipping a writer, not by editing this file.
 */
export function AccountActions({ account, venue }: { account: string; venue?: string }) {
  const t = useT()
  const [actions, setActions] = useState<Action[] | null>(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [values, setValues] = useState<Values>({})
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setError('')
    const res = await fetch(`/api/accounts/${encodeURIComponent(account)}/actions`)
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? t('accounts.actions.loadFailed'))
      setActions([])
      return
    }
    setActions(((await res.json()) as { actions: Action[] }).actions)
  }, [account, t])

  useEffect(() => { void load() }, [load])

  const open = actions?.find(a => a.id === openId)

  // Re-seeding on open is what makes the dropdowns useful: the options were
  // resolved against the live account, so the first row is a real position.
  function select(action: Action) {
    setOpenId(action.id)
    setValues(seed(action.paramsFields))
    setConfirming(false)
    setOutcome(null)
  }

  const groups = useMemo(() => {
    const out = new Map<string, Action[]>()
    for (const a of actions ?? []) {
      const key = a.group ?? ''
      const list = out.get(key)
      if (list) list.push(a)
      else out.set(key, [a])
    }
    return [...out.entries()]
  }, [actions])

  async function run() {
    if (!open) return
    setBusy(true)
    setOutcome(null)
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(account)}/actions/${encodeURIComponent(open.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: toParams(open.paramsFields, values) }),
      })
      const body = await res.json() as { error?: string; data?: unknown }
      if (!res.ok) setOutcome({ ok: false, text: body.error ?? t('accounts.actions.failed') })
      else setOutcome({ ok: true, text: JSON.stringify(body.data ?? { ok: true }, null, 2) })
      // Whatever happened, the dropdowns now describe a stale account.
      void load()
    } catch (err) {
      setOutcome({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (error) return <p className="text-xs py-3" style={{ color: 'var(--danger)' }}>{error}</p>
  if (!actions) return <p className="text-xs py-3" style={{ color: 'var(--muted)' }}>{t('accounts.actions.loading')}</p>
  if (actions.length === 0) return <p className="text-xs py-3" style={{ color: 'var(--muted)' }}>{t('accounts.actions.none')}</p>

  return (
    <div className="flex gap-4 pt-1" style={{ alignItems: 'flex-start' }}>
      {/* Action list, grouped as declared */}
      <div className="flex flex-col gap-3 shrink-0" style={{ minWidth: '11rem' }}>
        {groups.map(([group, list]) => (
          <div key={group} className="flex flex-col gap-1">
            {group && <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{group}</span>}
            {list.map(a => (
              <button
                key={a.id}
                onClick={() => select(a)}
                className="text-xs text-left px-2 py-1.5 rounded-md"
                title={a.description}
                style={{
                  border: '1px solid var(--border)',
                  background: openId === a.id ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                  color: a.danger ? 'var(--danger)' : 'var(--foreground)',
                }}
              >
                {a.displayName}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* The selected action's form */}
      <div className="flex-1 min-w-0">
        {!open && <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('accounts.actions.pickOne')}</p>}
        {open && (
          <div className="flex flex-col gap-3">
            {open.description && <p className="text-xs" style={{ color: 'var(--muted)' }}>{open.description}</p>}

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))' }}>
              {(open.paramsFields ?? []).filter(f => visible(f, values)).map(f => (
                <Field
                  key={f.name}
                  field={f}
                  venue={venue}
                  value={values[f.name] ?? ''}
                  onChange={v => setValues(prev => ({ ...prev, [f.name]: v }))}
                />
              ))}
            </div>

            {/* A dangerous action asks twice, and the second ask names the
                account — the mistake this prevents is firing at the right
                venue from the wrong credential. */}
            {confirming ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs" style={{ color: 'var(--danger)' }}>
                  {t('accounts.actions.confirm', { action: open.displayName, account })}
                </span>
                <button
                  onClick={() => void run()}
                  disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-md"
                  style={{ border: '1px solid var(--danger)', color: 'var(--danger)', opacity: busy ? 0.5 : 1 }}
                >
                  {busy ? t('accounts.actions.sending') : t('accounts.actions.confirmYes')}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="text-xs px-3 py-1.5 rounded-md"
                  style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                >
                  {t('accounts.actions.cancel')}
                </button>
              </div>
            ) : (
              <div>
                <button
                  onClick={() => (open.danger ? setConfirming(true) : void run())}
                  disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-md"
                  style={{
                    border: `1px solid ${open.danger ? 'var(--danger)' : 'var(--accent)'}`,
                    color: open.danger ? 'var(--danger)' : 'var(--accent)',
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  {busy ? t('accounts.actions.sending') : (open.submitLabel ?? open.displayName)}
                </button>
              </div>
            )}

            {outcome && (
              <pre
                className="text-[11px] rounded-md p-2 overflow-x-auto whitespace-pre-wrap"
                style={{
                  background: 'var(--background)',
                  border: `1px solid ${outcome.ok ? 'var(--border)' : 'var(--danger)'}`,
                  color: outcome.ok ? 'var(--foreground)' : 'var(--danger)',
                }}
              >
                {outcome.text}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
