'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { StrategyDefinition, StrategyInstanceView, ParamFieldDef, ParamIllustration, ParamPreset } from '@openwhaleorg/core'
import { InstanceDetail, IconMenu, ParamFieldsForm, iconFor, patchInstanceMeta } from '../InstancesClient'
import { buildParamsFromFields, fieldValuesFromParams, sameValues, type ParamValues } from '@/components/paramsIo'
import { ParamsToolbar, ParamsJsonView, useParamsJson, type ParamsView } from '@/components/ParamsToolbar'
import { useHistory, useUndoShortcuts } from '@/components/useHistory'
import { useDirtyFlag } from '@/components/unsaved'
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

          <InstanceStatePanel instance={instance} />

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
  useDirtyFlag(dirty, 'Account bindings')
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
            // Kindless type-pinned slots (raw executor slots) bind credentials
            // directly — match on the pinned type alone.
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
                    <optgroup label={slot.kind ? 'Credentials (legacy direct binding)' : 'Credentials'}>
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
 * sliders — instead of raw key:value chips. Collapsible because a ladder
 * strategy carries forty-odd fields.
 *
 * Editable whether or not the instance is running. A running instance derives
 * its triggers and subscriptions from its params once, at activation, so
 * saving new ones restarts it — the runtime rebuilds it from what was saved,
 * and rolls back to the previous settings if the new ones fail to activate.
 */
/**
 * The strategy's own KV state (`this.store`) — what it wrote, and a way to
 * wipe it. Strategies keep their bookkeeping here: baselines, idempotency
 * marks, cycle progress. Clearing makes an instance start over as if it had
 * never run, which is what you want after changing params it derived state
 * from, and never what you want mid-cycle — so the gateway refuses while the
 * instance is active and this panel says so rather than hiding the button.
 */
function InstanceStatePanel({ instance }: { instance: StrategyInstanceView }) {
  const [open, setOpen] = useState(false)
  const [keys, setKeys] = useState<string[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const pull = async () => {
    try {
      const r = await fetch(`/api/instances/${encodeURIComponent(instance.id)}/store`)
      if (r.ok) setKeys(((await r.json()) as { keys: string[] }).keys)
    } catch { /* the panel just shows nothing */ }
  }
  useEffect(() => { void pull() }, [instance.id])

  async function clear() {
    setBusy(true)
    setNotice('')
    try {
      const r = await fetch(`/api/instances/${encodeURIComponent(instance.id)}/store`, { method: 'DELETE' })
      const body = await r.text()
      if (!r.ok) { setNotice(body || `HTTP ${r.status}`); return }
      const { cleared } = JSON.parse(body) as { cleared: number }
      setNotice(`Cleared ${cleared} ${cleared === 1 ? 'key' : 'keys'}`)
      setConfirming(false)
      await pull()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const count = keys?.length ?? 0
  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <button className="flex items-center gap-2 text-left flex-1 py-0.5" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>Runtime state</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {keys === null ? '' : count === 0 ? '(empty)' : `(${count} ${count === 1 ? 'key' : 'keys'} the strategy stored)`}
          </span>
        </button>
        {notice && (
          <span className="text-xs" style={{ color: notice.startsWith('Cleared') ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>
        )}
        {confirming ? (
          <>
            <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>Clear all stored state?</span>
            <button onClick={() => setConfirming(false)} className="btn btn-secondary btn-sm shrink-0">Cancel</button>
            <button onClick={() => void clear()} disabled={busy} className="btn btn-danger-solid btn-sm shrink-0">
              {busy ? '…' : 'Confirm'}
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={instance.active || count === 0}
            className="btn btn-danger btn-sm shrink-0"
            title={instance.active ? 'Deactivate the instance first — clearing state under a running strategy loses its idempotency marks' : 'Delete everything the strategy wrote to this.store'}
          >
            Clear state
          </button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {instance.active
              ? 'Active — deactivate before clearing. A strategy reads this store mid-cycle; wiping it underneath one drops the marks that say a leg is already placed, and the next run acts as if nothing had happened.'
              : 'Everything the strategy wrote to this.store: baselines, idempotency marks, cycle bookkeeping. Clearing makes the next activation start from scratch. Params, accounts, runs and PnL are untouched.'}
          </p>
          {count > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {keys!.map(k => <span key={k} className="badge badge-neutral mono">{k}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function InstanceParamsPanel({ instance }: { instance: StrategyInstanceView }) {
  const [open, setOpen] = useState(true)
  const [fields, setFields] = useState<ParamFieldDef[] | null>(null)
  /* The same diagrams the create form shows. They were missing here only
     because this panel read paramsFields off the definition and stopped —
     and this is where params are actually TUNED, so it is the place the
     picture of what a knob does is worth the most. */
  const [illustrations, setIllustrations] = useState<ParamIllustration[] | undefined>(undefined)
  const [presets, setPresets] = useState<ParamPreset[] | undefined>(undefined)
  const history = useHistory<ParamValues>({})
  const values = history.state
  const setValues = history.set
  const [view, setView] = useState<ParamsView>('form')
  const json = useParamsJson(fields ?? [], values, setValues)
  /* Dirty is derived, not flagged: undo back to where you started has to stop
     claiming there is something to save. */
  const [saved, setSaved] = useState<ParamValues>({})
  const dirty = !sameValues(values, saved)
  useDirtyFlag(dirty, 'Parameters')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  /** Venue per bound slot label; the first entry is the default for fields naming no `accountSlot`. */
  const [slotVenues, setSlotVenues] = useState<Record<string, string>>({})
  const boundVenue = Object.values(slotVenues)[0]

  useEffect(() => {
    let gone = false
    void (async () => {
      const [r, ra] = await Promise.all([fetch('/api/strategies'), fetch('/api/accounts')])
      if (!r.ok || gone) return
      const defs = (await r.json()) as StrategyDefinition[]
      const def = defs.find(d => d.id === instance.strategyId)
      const f = def?.paramsFields ?? []
      setFields(f)
      setIllustrations(def?.paramsIllustrations)
      setPresets(def?.paramPresets)
      const seed = fieldValuesFromParams(f, instance.params)
      history.reset(seed)
      setSaved(seed)
      json.reset()
      setView('form')
      // The pickers and availability checks need the bound account's venue —
      // same derivation as the create form: slot binding → account → venue
      // pin from the implementation, credential type only as CEX fallback.
      if (ra.ok) {
        const { accounts, implementations } = (await ra.json()) as {
          accounts: Array<{ name: string; implementation?: string; credential?: string; type?: string }>
          implementations?: Array<{ id: string; type?: string }>
        }
        const implVenues = Object.fromEntries((implementations ?? []).flatMap(i => i.type ? [[i.id, i.type]] : []))
        const venues: Record<string, string> = {}
        for (const slot of def?.accountRequirements ?? []) {
          const bound = instance.credentials?.[slot.label] ?? instance.accounts?.[0]
          if (!bound) continue
          // Instances from before Account entities bind by credential name — match either
          const account = accounts.find(a => a.name === bound || a.credential === bound)
          const venue = account ? implVenues[account.implementation ?? ''] ?? account.type : undefined
          if (venue) venues[slot.label] = venue
        }
        if (!gone) setSlotVenues(venues)
      }
    })()
    return () => { gone = true }
    // Re-seed when activation state flips: an activation froze the params,
    // a deactivation just made them editable — either way start clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.strategyId, instance.active])

  // ⌘Z belongs to the panel only while it is open and the form has focus —
  // the JSON editor keeps Monaco's own undo.
  useUndoShortcuts(open && view === 'form', history.undo, history.redo)

  if (fields === null) return null
  if (fields.length === 0) return null

  async function save() {
    setSaving(true)
    setNotice('')
    // restart=1 tells the runtime to rebuild a RUNNING instance from the new
    // params rather than refusing the edit. On a stopped one it changes nothing.
    const res = await fetch(`/api/instances/${instance.id}?restart=1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: buildParamsFromFields(fields!, values) }),
    })
    setSaving(false)
    if (res.ok) { setSaved(values); setNotice(instance.active ? 'Saved & restarted ✓' : 'Saved ✓') }
    else setNotice(`Save failed: ${await res.text()}`)
  }

  const blocked = view === 'json' && json.error !== ''

  return (
    // overflow-clip, not hidden: hidden would make this a scroll container and
    // the sticky toolbar inside it would never stick.
    <div className="rounded-lg mb-4 overflow-clip" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      {/* Sticky so Save, undo and the view switch stay reachable however far
          down a long parameter form the user has scrolled. A div, not a button:
          the actions must not nest inside the collapse toggle. */}
      <div
        className="sticky top-0 z-20 w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium"
        style={{ background: 'var(--surface)', borderBottom: open ? '1px solid var(--border)' : 'none' }}
      >
        <button className="flex items-center gap-2 text-left py-0.5 min-w-0" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>Parameters</span>
          <span className="text-xs font-normal truncate" style={{ color: 'var(--muted)' }}>
            {instance.active ? '(active: saving restarts the instance)' : '(stopped: edit and save directly)'}
          </span>
          {dirty && <span className="text-xs shrink-0" style={{ color: 'var(--warning)' }}>Unsaved</span>}
        </button>
        <div className="flex-1" />
        {notice && <span className="text-xs shrink-0" style={{ color: notice.startsWith('Saved') ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>}
        {open && (
          <ParamsToolbar
            fields={fields}
            values={values}
            view={view}
            onView={(v) => {
              // Leaving JSON drops the draft: what the form shows is what the
              // last parse produced, and a stale draft would overwrite it later.
              if (v === 'form') json.reset()
              setView(v)
            }}
            history={history}
            onImport={(next) => {
              setValues(next, { coalesce: false })   // one undo step, not one per field
              json.reset()
              setNotice('')
            }}
            strategyId={instance.strategyId}
            instanceName={instance.name}
            disabled={blocked}
          />
        )}
        <button
          onClick={() => void save()}
          disabled={saving || !dirty || blocked}
          className="px-3 py-1.5 rounded-md text-xs shrink-0"
          style={{ background: dirty && !blocked ? 'var(--accent)' : 'var(--background)', color: dirty && !blocked ? '#fff' : 'var(--muted)', border: dirty && !blocked ? 'none' : '1px solid var(--border)' }}
        >
          {saving ? 'Saving…' : instance.active ? 'Save & restart' : 'Save'}
        </button>
      </div>
      {open && (
        <div className="px-4 pb-4">
          {view === 'json' ? (
            <div className="pt-2">
              <ParamsJsonView
                json={json}
                path={`params/${instance.id}.json`}
                note="The whole parameter document, exactly as Save sends it. A field left out falls back to its default."
              />
            </div>
          ) : (
            <ParamFieldsForm
              fields={fields}
              values={values}
              onChange={(v) => setValues(v)}
              strategyId={instance.strategyId}
              venueContext={boundVenue}
              slotVenues={slotVenues}
              {...(illustrations ? { illustrations } : {})}
              {...(presets ? { presets } : {})}
            />
          )}
          <div className="flex justify-end items-center gap-3 mt-3">
            {instance.active && dirty && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                Saving rebuilds the running instance from these values.
              </span>
            )}
            <button
              onClick={() => void save()}
              disabled={saving || !dirty || blocked}
              className="px-4 py-2 rounded-md text-sm"
              style={{ background: dirty && !blocked ? 'var(--accent)' : 'var(--surface)', color: dirty && !blocked ? '#fff' : 'var(--muted)', border: dirty && !blocked ? 'none' : '1px solid var(--border)' }}
            >
              {saving ? 'Saving…' : instance.active ? 'Save & restart' : 'Save parameters'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
