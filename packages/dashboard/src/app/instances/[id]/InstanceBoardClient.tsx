'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { StrategyDefinition, StrategyInstanceView, ParamFieldDef } from '@openwhaleorg/core'
import { InstanceDetail, IconMenu, ParamFieldsForm, buildParamsFromFields, fieldValuesFromParams, iconFor, patchInstanceMeta } from '../InstancesClient'
import { InstancePnlPanel } from './InstancePnlPanel'

/**
 * Full-page board for ONE instance — the same tabs as the list-page card, but
 * with room to breathe, a permalink, and it works for stopped instances too
 * (runs/logs come from the persisted trace store, not just process memory).
 */
export function InstanceBoardClient({ instanceId }: { instanceId: string }) {
  const [instance, setInstance] = useState<StrategyInstanceView | null>(null)
  const [missing, setMissing] = useState(false)
  const [acting, setActing] = useState(false)
  const [actError, setActError] = useState('')
  const [confirmStop, setConfirmStop] = useState(false)

  const pull = async () => {
    const r = await fetch('/api/instances')
    if (!r.ok) return
    const found = ((await r.json()) as StrategyInstanceView[]).find(i => i.id === instanceId) ?? null
    setInstance(found)
    setMissing(found === null)
  }

  useEffect(() => {
    let gone = false
    const guarded = async () => { if (!gone) await pull() }
    void guarded()
    const timer = setInterval(() => void guarded(), 10_000)
    return () => { gone = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  async function act(verb: 'activate' | 'deactivate') {
    setActing(true)
    setActError('')
    const res = await fetch(`/api/instances/${instanceId}/${verb}`, { method: 'POST' })
    if (!res.ok) setActError(await res.text())
    setActing(false)
    setConfirmStop(false)
    await pull()
  }

  const base = instance?.params?.base ?? {}
  const tunable = instance?.params?.tunable ?? {}
  const bindings = instance?.credentials
    ? Object.entries(instance.credentials).map(([slot, target]) => `${slot} → ${target}`)
    : instance?.accounts ?? []

  return (
    <div>
      <div className="mb-4">
        <Link href="/instances" className="text-xs" style={{ color: 'var(--muted)' }}>← Instances</Link>
      </div>

      {missing ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          Instance <span className="font-mono">{instanceId}</span> not found.
        </div>
      ) : !instance ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4 mb-1">
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <IconMenu
                current={iconFor(instance)}
                onPick={async (emoji) => {
                  await patchInstanceMeta(instance.id, { icon: emoji })
                  await pull()
                }}
              >
                <span>{iconFor(instance)}</span>
              </IconMenu>
              <EditableName
                name={instance.name}
                onSave={async (name) => {
                  await patchInstanceMeta(instance.id, { name })
                  await pull()
                }}
              />
            </h1>
            <div className="flex items-center gap-2 mt-2">
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: instance.active ? '#14532d' : '#292524',
                  color: instance.active ? 'var(--success)' : 'var(--muted)',
                }}
              >
                {instance.active ? 'active' : 'stopped'}
              </span>
              {instance.active ? (
                confirmStop ? (
                  <>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>Deactivate this instance?</span>
                    <button onClick={() => setConfirmStop(false)} className="px-3 py-1.5 rounded-md text-xs"
                      style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>Cancel</button>
                    <button onClick={() => void act('deactivate')} disabled={acting} className="px-3 py-1.5 rounded-md text-xs"
                      style={{ background: 'var(--danger)', color: '#fff' }}>{acting ? '…' : 'Confirm'}</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmStop(true)} className="px-3 py-1.5 rounded-md text-xs"
                    style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}>Deactivate</button>
                )
              ) : (
                <button onClick={() => void act('activate')} disabled={acting} className="px-3 py-1.5 rounded-md text-xs"
                  style={{ background: 'var(--accent)', color: '#fff' }}>{acting ? '…' : 'Activate'}</button>
              )}
            </div>
          </div>
          {actError && (
            <p className="text-xs px-3 py-2 rounded-md mb-2" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{actError}</p>
          )}
          {instance.description && (
            <div className="text-sm mb-1" style={{ color: 'var(--muted)' }}>{instance.description}</div>
          )}
          <div className="text-xs mb-4" style={{ color: 'var(--muted)' }}>
            strategy: <span style={{ color: 'var(--accent)' }}>{instance.strategyId}</span>
            {' · '}id: {instance.id}
            {bindings.length > 0 && <>{' · '}accounts: {bindings.join(', ')}</>}
          </div>

          <InstancePnlPanel instanceId={instance.id} />

          <InstanceAccountsPanel instance={instance} onSaved={pull} />

          <InstanceParamsPanel instance={instance} />

          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <InstanceDetail instanceId={instance.id} tall />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Account slot bindings — the same eligibility rules as the create form
 * (matching kind/venue accounts, legacy credentials as fallback). Bindings
 * feed session materialization at activation, so they are editable only while
 * the instance is stopped; active instances show them read-only.
 */
function InstanceAccountsPanel({ instance, onSaved }: { instance: StrategyInstanceView; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(true)
  const [slots, setSlots] = useState<Array<{ label: string; kind?: string; type?: string; optional?: boolean }> | null>(null)
  const [accounts, setAccounts] = useState<Array<{ name: string; kind?: string; type?: string; status: string }>>([])
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; type: string }>>([])
  const [credentialTypes, setCredentialTypes] = useState<Array<{ type: string; kinds: string[] }>>([])
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let gone = false
    void Promise.all([
      fetch('/api/strategies').then(r => r.json() as Promise<StrategyDefinition[]>),
      fetch('/api/accounts').then(r => r.json() as Promise<{ accounts: Array<{ name: string; kind?: string; type?: string; status: string }> }>),
      fetch('/api/credentials').then(r => r.json() as Promise<Array<{ id: string; name: string; type: string }>>),
      fetch('/api/credential-types').then(r => r.json() as Promise<Array<{ type: string; kinds: string[] }>>),
    ]).then(([s, a, c, ct]) => {
      if (gone) return
      setSlots(s.find(d => d.id === instance.strategyId)?.accountRequirements ?? [])
      setAccounts(a.accounts ?? [])
      setCredentials(c)
      setCredentialTypes(ct)
      setBindings(instance.credentials ?? {})
      setDirty(false)
    })
    return () => { gone = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.strategyId, instance.active])

  if (!slots || slots.length === 0) return null

  async function save() {
    setSaving(true)
    setNotice('')
    const res = await fetch(`/api/instances/${instance.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials: Object.fromEntries(Object.entries(bindings).filter(([, v]) => v)) }),
    })
    setSaving(false)
    if (res.ok) { setDirty(false); setNotice('Saved ✓'); await onSaved() }
    else setNotice(`Save failed: ${await res.text()}`)
  }

  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <button className="flex items-center gap-2 text-left flex-1 py-0.5" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>Accounts</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {instance.active ? '(active: read-only — deactivate to rebind)' : '(stopped: rebind and save)'}
          </span>
          {dirty && !instance.active && <span className="text-xs" style={{ color: 'var(--warning)' }}>Unsaved</span>}
        </button>
        {notice && <span className="text-xs" style={{ color: notice.startsWith('Saved') ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>}
        {!instance.active && (
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="px-3 py-1.5 rounded-md text-xs shrink-0"
            style={{ background: dirty ? 'var(--accent)' : 'var(--background)', color: dirty ? '#fff' : 'var(--muted)', border: dirty ? 'none' : '1px solid var(--border)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-2">
          {slots.map((slot) => {
            const eligible = accounts.filter(a =>
              a.status === 'ready' &&
              (slot.kind === undefined || a.kind === slot.kind) &&
              (slot.type === undefined || a.type === slot.type),
            )
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
                  value={bindings[slot.label] ?? ''}
                  disabled={instance.active}
                  onChange={(e) => { setBindings(prev => ({ ...prev, [slot.label]: e.target.value })); setDirty(true) }}
                  className="flex-1 rounded-md px-3 py-2 text-sm"
                  style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', opacity: instance.active ? 0.75 : 1 }}
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
                    <optgroup label="Credentials (legacy direct binding)">
                      {legacyEligible.map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
                    </optgroup>
                  )}
                </select>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Click-to-edit title — cosmetic meta, so it saves even while the instance is
 * active. Enter/blur commits, Esc cancels.
 */
function EditableName({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  async function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== name) await onSave(next)
    else setDraft(name)
  }

  if (!editing) {
    return (
      <button
        className="flex items-center gap-2 text-left group"
        title="Click to rename"
        onClick={() => { setDraft(name); setEditing(true) }}
      >
        {name}
        <span className="text-sm opacity-0 group-hover:opacity-60" style={{ color: 'var(--muted)' }}>✎</span>
      </button>
    )
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') { setDraft(name); setEditing(false) }
      }}
      className="text-2xl font-semibold px-2 py-0.5 rounded-md"
      style={{ background: 'var(--background)', border: '1px solid var(--accent)', color: 'var(--foreground)', minWidth: 320 }}
    />
  )
}

/**
 * The instance's params, rendered with the REAL form — sections, ladders,
 * sliders — instead of raw key:value chips. Read-only while the instance is
 * active (the runtime froze them at activation); once deactivated the same
 * panel saves edits directly. Collapsible because a ladder strategy carries
 * forty-odd fields.
 */
function InstanceParamsPanel({ instance }: { instance: StrategyInstanceView }) {
  const [open, setOpen] = useState(true)
  const [fields, setFields] = useState<ParamFieldDef[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [boundVenue, setBoundVenue] = useState<string | undefined>(undefined)

  useEffect(() => {
    let gone = false
    void (async () => {
      const [r, ra] = await Promise.all([fetch('/api/strategies'), fetch('/api/accounts')])
      if (!r.ok || gone) return
      const defs = (await r.json()) as StrategyDefinition[]
      const def = defs.find(d => d.id === instance.strategyId)
      const f = def?.paramsFields ?? []
      setFields(f)
      setValues(fieldValuesFromParams(f, instance.params))
      setDirty(false)
      // The pickers and availability checks need the bound account's venue —
      // same derivation as the create form: slot binding → account → type.
      if (ra.ok) {
        const { accounts } = (await ra.json()) as { accounts: Array<{ name: string; type?: string }> }
        for (const slot of def?.accountRequirements ?? []) {
          const bound = instance.credentials?.[slot.label] ?? instance.accounts?.[0]
          if (!bound) continue
          const account = accounts.find(a => a.name === bound)
          if (account?.type) { setBoundVenue(account.type); break }
        }
      }
    })()
    return () => { gone = true }
    // Re-seed when activation state flips: an activation froze the params,
    // a deactivation just made them editable — either way start clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.strategyId, instance.active])

  if (fields === null) return null
  if (fields.length === 0) return null

  async function save() {
    setSaving(true)
    setNotice('')
    const res = await fetch(`/api/instances/${instance.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: buildParamsFromFields(fields!, values) }),
    })
    setSaving(false)
    if (res.ok) { setDirty(false); setNotice('Saved ✓') }
    else setNotice(`Save failed: ${await res.text()}`)
  }

  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      {/* A div, not a button: the top save button must not nest inside the toggle. */}
      <div className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <button className="flex items-center gap-2 text-left flex-1 py-0.5" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>Parameters</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {instance.active ? '(active: read-only — deactivate to edit here)' : '(stopped: edit and save directly)'}
          </span>
          {dirty && !instance.active && <span className="text-xs" style={{ color: 'var(--warning)' }}>Unsaved</span>}
        </button>
        {notice && <span className="text-xs" style={{ color: notice.startsWith('Saved') ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>}
        {!instance.active && (
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="px-3 py-1.5 rounded-md text-xs shrink-0"
            style={{ background: dirty ? 'var(--accent)' : 'var(--background)', color: dirty ? '#fff' : 'var(--muted)', border: dirty ? 'none' : '1px solid var(--border)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-4">
          {/* One fieldset flips the whole tree read-only — inputs, toggles,
              list editors and sliders alike — with zero prop drilling. */}
          <fieldset disabled={instance.active} style={{ opacity: instance.active ? 0.75 : 1 }}>
            <ParamFieldsForm
              fields={fields}
              values={values}
              onChange={(v) => { setValues(v); setDirty(true) }}
              strategyId={instance.strategyId}
              venueContext={boundVenue}
            />
          </fieldset>
          {!instance.active && (
            <div className="flex justify-end mt-3">
              <button
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="px-4 py-2 rounded-md text-sm"
                style={{ background: dirty ? 'var(--accent)' : 'var(--surface)', color: dirty ? '#fff' : 'var(--muted)', border: dirty ? 'none' : '1px solid var(--border)' }}
              >
                {saving ? 'Saving…' : 'Save parameters'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
