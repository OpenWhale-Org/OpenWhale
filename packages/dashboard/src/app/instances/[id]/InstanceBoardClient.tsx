'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { StrategyDefinition, StrategyInstanceView, ParamFieldDef } from '@openwhaleorg/core'
import { InstanceDetail, IconMenu, ParamFieldsForm, buildParamsFromFields, fieldValuesFromParams, iconFor, patchInstanceMeta } from '../InstancesClient'

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
              {instance.name}
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
