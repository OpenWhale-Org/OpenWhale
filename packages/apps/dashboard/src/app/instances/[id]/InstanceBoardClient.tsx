'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { StrategyInstanceView } from '@openwhaleorg/core'
import type { StrategyDefinition, ParamFieldDef, ParamIllustration, ParamPreset, PresetSource } from '@/lib/core-types'
import { InstanceDetail, IconMenu, ParamFieldsForm, iconFor, patchInstanceMeta } from '../InstancesClient'
import { buildParamsFromFields, fieldValuesFromParams, sameValues, type ParamValues } from '@/components/paramsIo'
import { ParamsToolbar, ParamsJsonView, useParamsJson, type ParamsView } from '@/components/ParamsToolbar'
import { useHistory, useUndoShortcuts } from '@/components/useHistory'
import { useDirtyFlag } from '@/components/unsaved'
import { implVenueMap, pickerVenue } from '@/components/venue'
import { InstancePnlPanel } from './InstancePnlPanel'
import { InstanceMiscPanel } from './InstanceMiscPanel'
import { InstanceMonitorsPanel } from './InstanceMonitorsPanel'
import { InstanceSwitcher } from './InstanceSwitcher'
import { TopbarSlot } from '@/components/TopbarSlot'
import { Modal } from '@/components/Modal'
import { useT } from '@/i18n'

/**
 * Full-page board for ONE instance — the same tabs as the list-page card, but
 * with room to breathe, a permalink, and it works for stopped instances too
 * (runs/logs come from the persisted trace store, not just process memory).
 */
type BoardView = 'left' | 'split' | 'right'
const VIEW_KEY = 'ow:board:view'
const SPLIT_KEY = 'ow:board:split'

export function InstanceBoardClient({ instanceId }: { instanceId: string }) {
  const t = useT()
  const [instance, setInstance] = useState<StrategyInstanceView | null>(null)
  const [missing, setMissing] = useState(false)
  const [acting, setActing] = useState(false)
  const [actError, setActError] = useState('')
  const [confirmStop, setConfirmStop] = useState(false)
  /* Which columns the board shows under the PnL — parameters, both, or what
     the instance sees and did — remembered across boards like the Executors
     page remembers its split. */
  const [view, setView] = useState<BoardView>('split')
  useEffect(() => {
    try { const v = localStorage.getItem(VIEW_KEY); if (v === 'left' || v === 'split' || v === 'right') setView(v) } catch { /* no storage */ }
  }, [])
  const pickView = (v: BoardView) => { setView(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* no storage */ } }
  /* The divider between the columns, dragged like the Executors page's:
     the left column's share in percent, kept per browser. */
  const [splitPct, setSplitPct] = useState(42)
  useEffect(() => {
    try { const v = Number(localStorage.getItem(SPLIT_KEY)); if (v >= 25 && v <= 75) setSplitPct(v) } catch { /* no storage */ }
  }, [])
  const areaRef = useRef<HTMLDivElement>(null)
  function startDrag(e: React.MouseEvent) {
    e.preventDefault()
    const rect = areaRef.current?.getBoundingClientRect()
    if (!rect) return
    const move = (ev: MouseEvent) => setSplitPct(Math.min(75, Math.max(25, ((ev.clientX - rect.left) / rect.width) * 100)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setSplitPct(p => { try { localStorage.setItem(SPLIT_KEY, String(Math.round(p))) } catch { /* no storage */ } return p })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  /* The pinned header's height, published to the page so a second sticky bar
     (the parameter toolbar) pins below it rather than behind it. Measured
     because the title wraps: a hardcoded offset is wrong on the first long
     instance name. */
  const headRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = headRef.current
    if (!el) return
    const publish = () => el.parentElement?.style.setProperty('--ow-sticky-top', `${el.offsetHeight}px`)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [instance?.id, instance?.active])

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
      {/* The switcher lives in the shell's breadcrumb: it names the instance
          you are on, which is what that line is for, and it stays reachable
          while the board scrolls. */}
      <TopbarSlot><InstanceSwitcher currentId={instanceId} /></TopbarSlot>

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Link href="/instances" className="text-xs" style={{ color: 'var(--muted)' }}>← {t('nav.instances')}</Link>
      </div>

      {missing ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          {t('board.notFound', { id: instanceId })}
        </div>
      ) : !instance ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>{t('common.loading')}</div>
      ) : (
        <>
          {/* Pinned: on a board this long, which instance you are looking at
              and whether it is running are the two facts you must not lose
              track of while scrolling. */}
          <div ref={headRef} className="aurora-page-head mb-4">
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
              {/* Dry run is not a third kind of stopped: it runs, and queues
                  nothing. Amber, and it says so, because an instance that
                  looks live while placing nothing is the expensive confusion. */}
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={
                  !instance.active
                    ? { background: '#292524', color: 'var(--muted)' }
                    : instance.options?.dryRun
                      ? { background: '#3f2d14', color: 'var(--warning)' }
                      : { background: '#14532d', color: 'var(--success)' }
                }
                title={instance.options?.dryRun ? t('board.dryRunTitle') : undefined}
              >
                {instance.active ? (instance.options?.dryRun ? 'active · dry run' : 'active') : 'stopped'}
              </span>
              {instance.active ? (
                confirmStop ? (
                  <>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('board.deactivateConfirm')}</span>
                    <button onClick={() => setConfirmStop(false)} className="px-3 py-1.5 rounded-md text-xs"
                      style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>{t('common.cancel')}</button>
                    <button onClick={() => void act('deactivate')} disabled={acting} className="px-3 py-1.5 rounded-md text-xs"
                      style={{ background: 'var(--danger)', color: '#fff' }}>{acting ? '…' : 'Confirm'}</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmStop(true)} className="px-3 py-1.5 rounded-md text-xs"
                    style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}>{t('board.deactivate')}</button>
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
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            strategy: <span style={{ color: 'var(--accent)' }}>{instance.strategyId}</span>
            {' · '}id: {instance.id}
            {bindings.length > 0 && <>{' · '}accounts: {bindings.join(', ')}</>}
          </div>
          </div>

          <InstancePnlPanel instanceId={instance.id} />

          {/* Two columns under the PnL: what you set on the left, what the
              instance sees and did on the right — the Executors page's split,
              with the same switch. */}
          <div className="flex items-center gap-2 mb-3">
            <div className="flex rounded-md overflow-hidden h-8" style={{ border: '1px solid var(--border)' }}>
              {([['left', t('board.view.params')], ['split', t('board.view.split')], ['right', t('board.view.observe')]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => pickView(id)}
                  aria-pressed={view === id}
                  className="px-3 text-xs"
                  style={{ background: view === id ? 'var(--accent)' : 'transparent', color: view === id ? '#fff' : 'var(--muted)' }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/* left | divider | right — the divider drags, as on the Executors page. */}
          <div ref={areaRef} className="flex items-start">
            <div className="min-w-0" hidden={view === 'right'} style={{ flexBasis: view === 'split' ? `${splitPct}%` : '100%', flexGrow: 0, flexShrink: 0 }}>
              <InstanceAccountsPanel instance={instance} onSaved={pull} />
              <InstanceParamsPanel instance={instance} onSaved={pull} />
              <InstanceMiscPanel instance={instance} onSaved={pull} />
              <InstanceStatePanel instance={instance} />
            </div>
            {view === 'split' && (
              <div onMouseDown={startDrag} className="shrink-0 cursor-col-resize grid place-items-center mx-1 self-stretch" style={{ width: 8 }} title={t('executors.dragResize')}>
                <div className="w-0.5 h-8 rounded-full" style={{ background: 'var(--muted)', opacity: 0.6 }} />
              </div>
            )}
            <div className="flex-1 min-w-0" hidden={view === 'left'}>
              <InstanceMonitorsPanel instanceId={instance.id} active={instance.active} />
              <div
                className="rounded-lg overflow-hidden"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                <InstanceDetail instanceId={instance.id} tall />
              </div>
            </div>
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
  const t = useT()
  const [open, setOpen] = useState(true)
  const [slots, setSlots] = useState<Array<{ label: string; kind?: string; type?: string; optional?: boolean }> | null>(null)
  const [accounts, setAccounts] = useState<Array<{ name: string; kind?: string; type?: string; status: string }>>([])
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; type: string }>>([])
  const [credentialTypes, setCredentialTypes] = useState<Array<{ type: string; kinds: string[] }>>([])
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  useDirtyFlag(dirty, t('board.accountBindings'))
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
    if (res.ok) { setDirty(false); setNotice(t('board.saved')); await onSaved() }
    else setNotice(t('board.saveFailed', { error: await res.text() }))
  }

  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <button className="flex items-center gap-2 text-left flex-1 py-0.5" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>{t('instance.accounts')}</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {instance.active ? '(active: read-only — deactivate to rebind)' : '(stopped: rebind and save)'}
          </span>
          {dirty && !instance.active && <span className="text-xs" style={{ color: 'var(--warning)' }}>{t('board.unsaved')}</span>}
        </button>
        {notice && <span className="text-xs" style={{ color: notice.startsWith(t('board.savedPrefix')) ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>}
        {!instance.active && (
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="px-3 py-1.5 rounded-md text-xs shrink-0"
            style={{ background: dirty ? 'var(--accent)' : 'var(--background)', color: dirty ? '#fff' : 'var(--muted)', border: dirty ? 'none' : '1px solid var(--border)' }}
          >
            {saving ? t('common.saving') : t('common.save')}
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
                    <optgroup label={t('instance.accountsGroup')}>
                      {eligible.map(a => <option key={a.name} value={a.name}>{a.name} ({a.type ?? a.kind})</option>)}
                    </optgroup>
                  )}
                  {legacyEligible.length > 0 && (
                    <optgroup label={slot.kind ? t('instance.credentialsLegacy') : t('nav.credentials')}>
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
  const t = useT()
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
        title={t('board.clickRename')}
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
  const t = useT()
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
      setNotice(t('board.cleared', { n: cleared }))
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
          <span>{t('board.runtimeState')}</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {keys === null ? '' : count === 0 ? '(empty)' : `(${count} ${count === 1 ? 'key' : 'keys'} the strategy stored)`}
          </span>
        </button>
        {notice && (
          <span className="text-xs" style={{ color: notice.startsWith(t('board.clearedPrefix')) ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>
        )}
        {confirming ? (
          <>
            <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{t('board.clearConfirm')}</span>
            <button onClick={() => setConfirming(false)} className="btn btn-secondary btn-sm shrink-0">{t('common.cancel')}</button>
            <button onClick={() => void clear()} disabled={busy} className="btn btn-danger-solid btn-sm shrink-0">
              {busy ? '…' : t('common.confirm')}
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={instance.active || count === 0}
            className="btn btn-danger btn-sm shrink-0"
            title={instance.active ? t('board.clearBlockedTitle') : t('board.clearTitle')}
          >
            {t('board.clearState')}
          </button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {instance.active
              ? t('board.clearBlockedBody')
              : t('board.clearBody')}
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

/** The strategy's default quick / pinned sets, or the operator's own when set on the instance. */
export function effectiveQuick(fields: ParamFieldDef[], instance: { quickParams?: string[] | undefined; pinnedParams?: string[] | undefined }): { quick: string[]; pinned: string[]; overridden: boolean } {
  const names = new Set(fields.map(f => f.name))
  const pinned = (instance.pinnedParams ?? fields.filter(f => f.pinned).map(f => f.name)).filter(n => names.has(n)).slice(0, 3)
  const quickOwn = (instance.quickParams ?? fields.filter(f => f.quick).map(f => f.name)).filter(n => names.has(n))
  // Pinned implies quick, whichever set named it.
  const quick = [...new Set([...pinned, ...quickOwn])]
  return { quick, pinned, overridden: instance.quickParams !== undefined || instance.pinnedParams !== undefined }
}

/**
 * The picker for both sets: every field with a quick checkbox and a pin
 * toggle (three at most). Saved as the instance's own sets; "strategy
 * defaults" clears them.
 */
function QuickParamsDialog({ fields, quick, pinned, onSave, onClose }: {
  fields: ParamFieldDef[]
  quick: string[]
  pinned: string[]
  onSave: (next: { quickParams: string[] | null; pinnedParams: string[] | null }) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [q, setQ] = useState<Set<string>>(new Set(quick))
  const [p, setP] = useState<string[]>(pinned)
  const [busy, setBusy] = useState(false)
  const toggleQuick = (name: string) => setQ(prev => {
    const next = new Set(prev)
    if (next.has(name)) { next.delete(name); setP(cur => cur.filter(n => n !== name)) } else next.add(name)
    return next
  })
  const togglePin = (name: string) => {
    if (p.includes(name)) { setP(p.filter(n => n !== name)); return }
    if (p.length >= 3) return
    setP([...p, name])
    setQ(prev => new Set([...prev, name]))
  }
  const label = (f: ParamFieldDef) => typeof f.displayName === 'string' ? f.displayName : f.name
  const groups: Array<['base' | 'tunable', ParamFieldDef[]]> = [['base', fields.filter(f => f.group === 'base')], ['tunable', fields.filter(f => f.group === 'tunable')]]
  return (
    <Modal onClose={onClose} maxWidth="44rem" height="80vh">
      <div className="flex flex-col h-full min-h-0">
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-base font-semibold">{t('board.quick.dialogTitle')}</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{t('board.quick.dialogHint')}</p>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-3 flex flex-col gap-4">
          {groups.map(([group, list]) => list.length > 0 && (
            <div key={group} className="flex flex-col gap-1">
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{group}</div>
              {list.map(f => {
                const isQuick = q.has(f.name)
                const isPinned = p.includes(f.name)
                return (
                  <div key={f.name} className="flex items-center gap-3 px-2 py-1.5 rounded-md" style={{ background: isQuick ? 'var(--accent-soft)' : 'transparent' }}>
                    <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                      <input type="checkbox" checked={isQuick} onChange={() => toggleQuick(f.name)} />
                      <span className="text-sm truncate">{label(f)}</span>
                      <span className="text-[10px] font-mono truncate" style={{ color: 'var(--muted)' }}>{f.name}</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => togglePin(f.name)}
                      disabled={!isPinned && p.length >= 3}
                      className="text-xs px-2 py-0.5 rounded"
                      title={!isPinned && p.length >= 3 ? t('board.quick.pinLimit') : t('board.quick.pin')}
                      style={isPinned
                        ? { background: 'var(--accent)', color: '#fff' }
                        : { background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)', opacity: p.length >= 3 ? 0.5 : 1 }}
                    >
                      {isPinned ? '★' : '☆'} {t('board.quick.pin')}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setBusy(true); void onSave({ quickParams: null, pinnedParams: null }).finally(() => setBusy(false)) }}>
            {t('board.quick.reset')}
          </button>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{p.length}/3 {t('board.quick.pin')}</span>
          <div className="flex-1" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setBusy(true); void onSave({ quickParams: [...q], pinnedParams: p }).finally(() => setBusy(false)) }}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function InstanceParamsPanel({ instance, onSaved }: { instance: StrategyInstanceView; onSaved: () => Promise<void> }) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const [fields, setFields] = useState<ParamFieldDef[] | null>(null)
  /* Quick parameters on top, the whole form folded beneath. */
  const [allOpen, setAllOpen] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  /* The same diagrams the create form shows. They were missing here only
     because this panel read paramsFields off the definition and stopped —
     and this is where params are actually TUNED, so it is the place the
     picture of what a knob does is worth the most. */
  const [illustrations, setIllustrations] = useState<ParamIllustration[] | undefined>(undefined)
  const [presets, setPresets] = useState<ParamPreset[] | undefined>(undefined)
  const [presetSource, setPresetSource] = useState<PresetSource | undefined>(undefined)
  const [illustrationData, setIllustrationData] = useState<boolean | undefined>(undefined)
  const history = useHistory<ParamValues>({})
  const values = history.state
  const setValues = history.set
  const [view, setView] = useState<ParamsView>('form')
  const json = useParamsJson(fields ?? [], values, setValues)
  /* Dirty is derived, not flagged: undo back to where you started has to stop
     claiming there is something to save. */
  const [saved, setSaved] = useState<ParamValues>({})
  const dirty = !sameValues(values, saved)
  useDirtyFlag(dirty, t('params.title'))
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
      setPresetSource(def?.presetSource)
      setIllustrationData(def?.illustrationData)
      const seed = fieldValuesFromParams(f, instance.params)
      history.reset(seed)
      setSaved(seed)
      json.reset()
      setView('form')
      // The pickers and availability checks need the bound account's venue:
      // slot binding → account → pickerVenue (see components/venue.ts, the one
      // place that knows how a venue is resolved).
      if (ra.ok) {
        const { accounts, implementations } = (await ra.json()) as {
          accounts: Array<{ name: string; implementation?: string; credential?: string; type?: string; venue?: string }>
          implementations?: Array<{ id: string; venue?: string; type?: string }>
        }
        const implVenues = implVenueMap(implementations)
        const venues: Record<string, string> = {}
        for (const slot of def?.accountRequirements ?? []) {
          const bound = instance.credentials?.[slot.label] ?? instance.accounts?.[0]
          if (!bound) continue
          // Instances from before Account entities bind by credential name — match either
          const account = accounts.find(a => a.name === bound || a.credential === bound)
          const venue = pickerVenue(account, implVenues)
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
    if (res.ok) { setSaved(values); setNotice(instance.active ? t('board.savedRestarted') : t('board.saved')) }
    else setNotice(t('board.saveFailed', { error: await res.text() }))
  }

  const blocked = view === 'json' && json.error !== ''
  const sets = effectiveQuick(fields, instance)
  const quickFields = sets.quick.map(n => fields!.find(f => f.name === n)!).filter(Boolean)
  const saveSets = async (next: { quickParams: string[] | null; pinnedParams: string[] | null }) => {
    await patchInstanceMeta(instance.id, next)
    setConfiguring(false)
    await onSaved()
  }

  return (
    // overflow-clip, not hidden: hidden would make this a scroll container and
    // the sticky toolbar inside it would never stick.
    <div className="rounded-lg mb-4 overflow-clip" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      {/* Sticky so Save, undo and the view switch stay reachable however far
          down a long parameter form the user has scrolled. A div, not a button:
          the actions must not nest inside the collapse toggle. */}
      <div
        className="sticky z-20 w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium"
        style={{
          // Below the page's own pinned header, not behind it.
          top: 'var(--ow-sticky-top, 0px)',
          background: 'var(--surface)',
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        <button className="flex items-center gap-2 text-left py-0.5 min-w-0" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>{t('params.title')}</span>
          <span className="text-xs font-normal truncate" style={{ color: 'var(--muted)' }}>
            {instance.active ? '(active: saving restarts the instance)' : '(stopped: edit and save directly)'}
          </span>
          {dirty && <span className="text-xs shrink-0" style={{ color: 'var(--warning)' }}>{t('board.unsaved')}</span>}
        </button>
        <div className="flex-1" />
        {notice && <span className="text-xs shrink-0" style={{ color: notice.startsWith(t('board.savedPrefix')) ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>}
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
          {saving ? t('common.saving') : instance.active ? t('board.saveRestart') : t('common.save')}
        </button>
      </div>
      {open && (
        <div className="px-4 pb-4">
          {view === 'json' ? (
            <div className="pt-2">
              <ParamsJsonView
                json={json}
                path={`params/${instance.id}.json`}
                note={t('params.jsonNoteSave')}
              />
            </div>
          ) : (
            <>
              {/* Quick parameters: the strategy's pick, or the operator's. The
                  same values and history as the full form below — an edit here
                  is an edit there, and one Save applies both. */}
              <div className="flex items-center gap-2 text-xs mt-3 mb-1" style={{ color: 'var(--muted)' }}>
                <span>▾</span>
                <span>{t('board.quick.title')} ({quickFields.length})</span>
                <span className="text-[10px]">· {sets.overridden ? t('board.quick.overridden') : t('board.quick.defaults')}</span>
                {sets.pinned.length > 0 && (
                  <span className="text-[10px]" title={sets.pinned.join(', ')}>· ★ {sets.pinned.length}</span>
                )}
                <div className="flex-1" />
                <button type="button" className="text-xs" style={{ color: 'var(--accent)' }} onClick={() => setConfiguring(true)}>{t('board.quick.configure')}</button>
              </div>
              {quickFields.length === 0 ? (
                <p className="text-xs py-1" style={{ color: 'var(--muted)' }}>{t('board.quick.none')}</p>
              ) : (
                <ParamFieldsForm
                  fields={quickFields}
                  values={values}
                  onChange={(v) => setValues(v)}
                  strategyId={instance.strategyId}
                  venueContext={boundVenue}
                  slotVenues={slotVenues}
                  slotBindings={instance.credentials ?? {}}
                />
              )}
              <button type="button" className="flex items-center gap-2 text-xs mt-4 mb-1" style={{ color: 'var(--muted)' }} onClick={() => setAllOpen(v => !v)}>
                <span>{allOpen ? '▾' : '▸'}</span>
                <span>{t('board.quick.all')} ({fields.length})</span>
              </button>
              {allOpen && (
                <ParamFieldsForm
                  fields={fields}
                  values={values}
                  onChange={(v) => setValues(v)}
                  strategyId={instance.strategyId}
                  venueContext={boundVenue}
                  slotVenues={slotVenues}
                  {...(illustrations ? { illustrations } : {})}
                  {...(presets ? { presets } : {})}
                  presetSource={presetSource}
                  slotBindings={instance.credentials ?? {}}
                  illustrationData={illustrationData}
                />
              )}
              {configuring && (
                <QuickParamsDialog fields={fields} quick={sets.quick} pinned={sets.pinned} onSave={saveSets} onClose={() => setConfiguring(false)} />
              )}
            </>
          )}
          <div className="flex justify-end items-center gap-3 mt-3">
            {instance.active && dirty && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                {t('board.saveRebuilds')}
              </span>
            )}
            <button
              onClick={() => void save()}
              disabled={saving || !dirty || blocked}
              className="px-4 py-2 rounded-md text-sm"
              style={{ background: dirty && !blocked ? 'var(--accent)' : 'var(--surface)', color: dirty && !blocked ? '#fff' : 'var(--muted)', border: dirty && !blocked ? 'none' : '1px solid var(--border)' }}
            >
              {saving ? t('common.saving') : instance.active ? t('board.saveRestart') : t('board.saveParams')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
