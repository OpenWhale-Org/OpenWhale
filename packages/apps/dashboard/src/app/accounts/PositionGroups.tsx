'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Modal } from '@/components/Modal'
import { Select } from '@/components/Select'
import { useT } from '@/i18n'

/**
 * Position combinations: positions across accounts read as one trade with one
 * PnL. Manual ones are the operator's; strategy ones follow their instance
 * (hide-able, not editable). Shapes mirror the gateway's positionGroups.ts.
 */

export type Side = 'long' | 'short' | '*'
export interface Member { account: string; symbol: string; side: Side }
export interface GroupInfo { id: string; name: string; source: 'manual' | 'instance'; instanceId?: string; hidden: boolean; members: Member[] }
interface LiveRow { side: 'long' | 'short'; value: number; pnl: number }
interface LiveMember extends Member { rows: LiveRow[]; error?: string }
interface LiveGroup extends GroupInfo { members: LiveMember[]; totals: { gross: number; net: number; pnl: number; open: number } }

export const GROUPS_CHANGED = 'ow:position-groups-changed'
const announce = () => window.dispatchEvent(new Event(GROUPS_CHANGED))

async function api(path: string, method: string, body?: unknown): Promise<string | undefined> {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  if (res.ok) { announce(); return undefined }
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`
}
export const createGroup = (name: string, members: Member[] = []) => api('/api/position-groups', 'POST', { name, members })
export const addToGroup = (id: string, members: Member[]) => api(`/api/position-groups/${encodeURIComponent(id)}/members`, 'POST', { members })
const key = (m: Member) => `${m.account}|${m.symbol}|${m.side}`

/**
 * Save a dialog's whole form. A new combination is one POST; an existing one
 * is a rename plus the member difference, because the API adds and removes
 * members rather than replacing the set.
 */
async function saveGroup(group: GroupInfo | undefined, name: string, members: Member[]): Promise<string | undefined> {
  if (!group) return createGroup(name, members)
  const base = `/api/position-groups/${encodeURIComponent(group.id)}`
  if (name !== group.name) { const e = await api(base, 'PATCH', { name }); if (e) return e }
  const before = new Set(group.members.map(key)), after = new Set(members.map(key))
  const added = members.filter(m => !before.has(key(m)))
  if (added.length > 0) { const e = await api(`${base}/members`, 'POST', { members: added }); if (e) return e }
  for (const m of group.members.filter(m => !after.has(key(m)))) {
    const e = await api(`${base}/members`, 'DELETE', m); if (e) return e
  }
  return undefined
}

const usd = (v: number) => `$${Math.round(v).toLocaleString()}`
const signedUsd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const tone = (v: number) => (v > 0 ? 'var(--success, #22c55e)' : v < 0 ? 'var(--danger, #ef4444)' : 'var(--muted)')

/** The groups list, kept fresh when any part of the page changes it. */
export function useGroups(): GroupInfo[] {
  const [groups, setGroups] = useState<GroupInfo[]>([])
  useEffect(() => {
    const load = () => void fetch('/api/position-groups').then(r => (r.ok ? r.json() : { groups: [] })).then((d: { groups: GroupInfo[] }) => setGroups(d.groups)).catch(() => {})
    load()
    window.addEventListener(GROUPS_CHANGED, load)
    return () => window.removeEventListener(GROUPS_CHANGED, load)
  }, [])
  return groups
}

export function PositionGroupsPanel({ accounts }: { accounts: string[] }) {
  const t = useT()
  const [data, setData] = useState<LiveGroup[] | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState('')
  /* `{}` opens the dialog for a new combination, `{group}` for an existing
     one — one piece of state, so only ever one dialog is up. */
  const [editing, setEditing] = useState<{ group?: LiveGroup } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [showFlat, setShowFlat] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const res = await fetch(`/api/position-groups/live${showHidden ? '?hidden=1' : ''}`)
    if (!res.ok) { setError(t('groups.loadFailed')); return }
    setData(((await res.json()) as { groups: LiveGroup[] }).groups)
  }, [showHidden, t])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const on = () => void load()
    window.addEventListener(GROUPS_CHANGED, on)
    return () => window.removeEventListener(GROUPS_CHANGED, on)
  }, [load])

  const act = async (p: Promise<string | undefined>) => { const e = await p; if (e) setError(e) }
  const total = (data ?? []).filter(g => !g.hidden).reduce((n, g) => n + g.totals.pnl, 0)
  /* What is open is what the operator is watching: those sort by PnL, biggest
     winner first. An instance that holds nothing says nothing every second of
     the day, so the flat ones fold into one line at the bottom. */
  const open = (data ?? []).filter(g => g.totals.open > 0).sort((a, b) => b.totals.pnl - a.totals.pnl)
  const flat = (data ?? []).filter(g => g.totals.open === 0).sort((a, b) => a.name.localeCompare(b.name))

  /* A flat combination opens only on demand: collapsed unless toggled, while
     one holding positions is open unless toggled. */
  const card = (g: LiveGroup) => (
    <GroupCard key={g.id} g={g} accounts={accounts} collapsed={collapsed.has(g.id) !== (g.totals.open > 0)}
      onToggle={() => setCollapsed(prev => { const n = new Set(prev); if (!n.delete(g.id)) n.add(g.id); return n })}
      onEdit={() => setEditing({ group: g })} onAct={act} />
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{t('groups.title')}</span>
        {data && <span className="text-xs font-mono" style={{ color: tone(total) }}>{t('groups.totalPnl')} {signedUsd(total)}</span>}
        <span className="flex-1" />
        <button onClick={() => setEditing({})} className="h-8 px-3 rounded-md text-xs" style={{ background: 'var(--accent)', color: '#fff' }}>{t('groups.create')}</button>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />{t('groups.showHidden')}
        </label>
        <button onClick={() => void load()} className="w-8 h-8 rounded-md text-base" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }} title={t('groups.refresh')}>↻</button>
      </div>
      {error && <p className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{error}</p>}
      {!data && <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('common.loading')}</p>}
      {data?.length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('groups.empty')}</p>}
      {open.map(card)}
      {flat.length > 0 && (
        <>
          <button onClick={() => setShowFlat(v => !v)} className="flex items-center gap-2 text-xs px-1 py-1" style={{ color: 'var(--muted)' }}>
            <span>{showFlat ? '▾' : '▸'}</span>{t('groups.flatSection', { n: flat.length })}
          </button>
          {showFlat && flat.map(card)}
        </>
      )}
      {editing && (
        <GroupDialog group={editing.group} accounts={accounts} onClose={() => setEditing(null)}
          onSave={async (name, members) => { const e = await saveGroup(editing.group, name, members); if (e) { setError(e); return false } setEditing(null); return true }} />
      )}
    </div>
  )
}

/** Name and members of one combination, filled in before anything is saved. */
function GroupDialog({ group, accounts, onClose, onSave }: {
  group?: GroupInfo
  accounts: string[]
  onClose: () => void
  onSave: (name: string, members: Member[]) => Promise<boolean>
}) {
  const t = useT()
  const [name, setName] = useState(group?.name ?? '')
  const [members, setMembers] = useState<Member[]>(group?.members ?? [])
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<{ account: string; symbol: string; side: Side }>({ account: accounts[0] ?? '', symbol: '', side: '*' })
  const positions = useAccountPositions(draft.account)

  const addDraft = () => {
    if (!draft.account || !draft.symbol) return
    const m: Member = { account: draft.account, symbol: draft.symbol, side: draft.side }
    setMembers(prev => (prev.some(x => key(x) === key(m)) ? prev : [...prev, m]))
    setDraft(d => ({ ...d, symbol: '' }))
  }
  const symbols = [...new Set(positions.map(p => p.id))]

  return (
    <Modal onClose={onClose} maxWidth="42rem">
      <form className="flex flex-col gap-4 p-5" onSubmit={async (e) => {
        e.preventDefault()
        if (!name.trim() || saving) return
        setSaving(true)
        if (!await onSave(name.trim(), members)) setSaving(false)
      }}>
        <h2 className="text-base font-semibold">{group ? t('groups.editTitle') : t('groups.createTitle')}</h2>
        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }}>
          {t('groups.nameLabel')}
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('groups.newPlaceholder')}
            className="h-9 px-2 rounded-md text-sm" style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }} />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('groups.membersLabel')}</span>
          {members.length === 0 && <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>{t('groups.noMembers')}</p>}
          {members.map(m => (
            <div key={key(m)} className="flex items-center gap-2 text-xs py-1" style={{ borderTop: '1px solid var(--border)' }}>
              <span className="truncate" style={{ width: '11rem' }} title={m.account}>{m.account}</span>
              <span className="font-mono flex-1 truncate" title={m.symbol}>{m.symbol}</span>
              <span style={{ width: '5rem', color: m.side === '*' ? 'var(--muted)' : m.side === 'long' ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
                {m.side === '*' ? t('groups.anySide') : m.side}
              </span>
              <button type="button" className="px-1" style={{ color: 'var(--muted)' }} title={t('groups.removeMember')}
                onClick={() => setMembers(prev => prev.filter(x => key(x) !== key(m)))}>×</button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-2 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
            <Select size="sm" value={draft.account} onChange={(v) => setDraft(d => ({ ...d, account: v, symbol: '' }))} placeholder={t('groups.pickAccount')}
              style={{ width: '11rem' }} options={accounts.map(a => ({ value: a, label: a }))} />
            <Select size="sm" value={draft.symbol} onChange={(v) => setDraft(d => ({ ...d, symbol: v }))} placeholder={t('groups.pickPosition')}
              style={{ flex: 1, minWidth: '12rem' }} disabled={!draft.account} searchable
              options={symbols.map(sym => ({ value: sym, label: sym, hint: positions.filter(p => p.id === sym).map(p => `${p.side} ${usd(Math.abs(p.value))}`).join(' / ') }))} />
            <Select size="sm" value={draft.side} onChange={(v) => setDraft(d => ({ ...d, side: v as Side }))} style={{ width: '7rem' }}
              options={[{ value: '*', label: t('groups.anySide') }, { value: 'long', label: 'long' }, { value: 'short', label: 'short' }]} />
            <button type="button" onClick={addDraft} disabled={!draft.account || !draft.symbol} className="h-8 px-3 rounded-md text-xs"
              style={{ border: '1px solid var(--border)', color: 'var(--foreground)', opacity: !draft.account || !draft.symbol ? 0.5 : 1 }}>{t('groups.addMember')}</button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 px-4 rounded-md text-xs" style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}>{t('common.cancel')}</button>
          <button type="submit" disabled={!name.trim() || saving} className="h-9 px-4 rounded-md text-xs"
            style={{ background: 'var(--accent)', color: '#fff', opacity: !name.trim() || saving ? 0.6 : 1 }}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** What an account holds right now, for picking a member out of it. */
function useAccountPositions(account: string): Array<{ id: string; side: string; value: number }> {
  const [positions, setPositions] = useState<Array<{ id: string; side: string; value: number }>>([])
  useEffect(() => {
    setPositions([])
    if (!account) return
    let gone = false
    void fetch(`/api/accounts/${encodeURIComponent(account)}/detail`).then(r => (r.ok ? r.json() : null))
      .then((d: { sections?: { positions?: Array<{ id: string; side: string; value: number }> } } | null) => { if (!gone) setPositions(d?.sections?.positions ?? []) })
      .catch(() => {})
    return () => { gone = true }
  }, [account])
  return positions
}

function GroupCard({ g, collapsed, onToggle, onEdit, onAct }: {
  g: LiveGroup; accounts: string[]; collapsed: boolean; onToggle: () => void; onEdit: () => void; onAct: (p: Promise<string | undefined>) => Promise<void>
}) {
  const t = useT()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const manual = g.source === 'manual'
  const base = `/api/position-groups/${encodeURIComponent(g.id)}`

  return (
    <div className="rounded-lg" style={{ border: '1px solid var(--border)', opacity: g.hidden ? 0.6 : 1 }}>
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={onToggle}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>{collapsed ? '▸' : '▾'}</span>
        <span className="text-sm font-medium truncate" style={{ maxWidth: '16rem' }} title={g.name}>{g.name}</span>
        <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--border) 60%, transparent)', color: 'var(--muted)' }}>
          {manual ? t('groups.manual') : t('groups.strategy')}
        </span>
        {g.instanceId && <Link href={`/instances/${encodeURIComponent(g.instanceId)}`} onClick={e => e.stopPropagation()} className="text-[11px]" style={{ color: 'var(--accent)' }}>{t('groups.openInstance')}</Link>}
        <span className="flex-1" />
        <span className="text-xs font-mono text-right shrink-0" style={{ color: 'var(--muted)', width: '4.5rem' }}>{t('groups.legs', { n: g.totals.open })}</span>
        <span className="text-xs font-mono text-right shrink-0" style={{ color: 'var(--muted)', width: '7.5rem' }}>{t('groups.gross')} {usd(g.totals.gross)}</span>
        <span className="text-xs font-mono text-right shrink-0" style={{ color: 'var(--muted)', width: '7rem' }}>{t('groups.net')} {signedUsd(g.totals.net)}</span>
        <span className="text-sm font-mono text-right shrink-0" style={{ color: tone(g.totals.pnl), width: '6.5rem' }}>{signedUsd(g.totals.pnl)}</span>
        {/* One fixed-width tray: Rename and Delete exist only on manual cards,
            and without it Hide would sit at a different x on every card. */}
        <span className="flex items-center justify-end gap-1 shrink-0" style={{ width: '10rem' }} onClick={e => e.stopPropagation()}>
          {manual && <button className="text-xs px-1.5" style={{ color: 'var(--muted)' }} onClick={onEdit}>{t('groups.edit')}</button>}
          <button className="text-xs px-1.5" style={{ color: 'var(--muted)' }} onClick={() => void onAct(api(base, 'PATCH', { hidden: !g.hidden }))}>{g.hidden ? t('groups.unhide') : t('groups.hide')}</button>
          {manual && (
            <button className="text-xs px-1.5" style={{ color: 'var(--danger, #ef4444)' }} onMouseLeave={() => setConfirmDelete(false)}
              onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return } void onAct(api(base, 'DELETE')) }}>
              {confirmDelete ? t('common.deleteConfirm') : t('common.delete')}
            </button>
          )}
        </span>
      </div>
      {!collapsed && (
        <div className="px-3 pb-3 overflow-x-auto scroll-hidden">
          {/* Fixed layout, not content-driven: a card holding CL/USDT:USDT and
              one holding RAM/USDT:USDT must put Side, Value and uPnL at the
              same x, since the eye reads down the stack of cards. */}
          <table className="w-full text-xs" style={{ minWidth: '34rem', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '13rem' }} />
              <col />
              <col style={{ width: '6rem' }} />
              <col style={{ width: '8rem' }} />
              <col style={{ width: '8rem' }} />
              <col style={{ width: '2rem' }} />
            </colgroup>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="text-left py-1 font-medium">{t('groups.col.account')}</th>
                <th className="text-left py-1 font-medium">{t('accounts.col.symbol')}</th>
                <th className="text-left py-1 font-medium">{t('accounts.col.side')}</th>
                <th className="text-right py-1 font-medium">{t('accounts.col.value')}</th>
                <th className="text-right py-1 font-medium">{t('accounts.col.upnl')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {g.members.flatMap(m => {
                const remove = (
                  <td className="text-right">
                    {manual && <button className="px-1" style={{ color: 'var(--muted)' }} title={t('groups.removeMember')} onClick={() => void onAct(api(`${base}/members`, 'DELETE', m))}>×</button>}
                  </td>
                )
                if (m.rows.length === 0) {
                  return [<tr key={`${m.account}|${m.symbol}|${m.side}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="py-1 truncate" title={m.account}>{m.account}</td><td className="py-1 font-mono truncate" title={m.symbol}>{m.symbol}</td>
                    <td className="py-1" style={{ color: 'var(--muted)' }}>{m.side === '*' ? t('groups.anySide') : m.side}</td>
                    <td colSpan={2} className="py-1 text-right" style={{ color: m.error ? 'var(--danger, #ef4444)' : 'var(--muted)' }}>{m.error ?? t('groups.flat')}</td>
                    {remove}
                  </tr>]
                }
                return m.rows.map((r, i) => (
                  <tr key={`${m.account}|${m.symbol}|${m.side}|${r.side}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="py-1 truncate" title={m.account}>{i === 0 ? m.account : ''}</td>
                    <td className="py-1 font-mono truncate" title={m.symbol}>{i === 0 ? m.symbol : ''}</td>
                    <td className="py-1" style={{ color: r.side === 'long' ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>{r.side}</td>
                    <td className="py-1 text-right font-mono">{usd(r.value)}</td>
                    <td className="py-1 text-right font-mono" style={{ color: tone(r.pnl) }}>{signedUsd(r.pnl)}</td>
                    {i === 0 ? remove : <td />}
                  </tr>
                ))
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** In an account's positions table: which combinations a row is in, and adding it to one. */
export function RowGroups({ account, symbol, side, groups }: { account: string; symbol: string; side: 'long' | 'short'; groups: GroupInfo[] }) {
  const t = useT()
  const mine = groups.filter(g => g.members.some(m => m.account === account && m.symbol === symbol && (m.side === '*' || m.side === side)))
  const addable = groups.filter(g => g.source === 'manual' && !mine.includes(g))
  const member: Member = { account, symbol, side }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap justify-end">
      {mine.map(g => (
        <span key={g.id} className="text-[11px] px-1.5 rounded-full whitespace-nowrap" title={g.source === 'instance' ? t('groups.strategy') : t('groups.manual')}
          style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)' }}>{g.name}</span>
      ))}
      <select value="" className="text-[11px] rounded px-1 h-5" style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--muted)', width: '1.75rem' }}
        title={t('groups.addTo')}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__new__') {
            const name = window.prompt(t('groups.newPrompt'), symbol.split('/')[0])
            if (name) void createGroup(name, [member])
          } else if (v) void addToGroup(v, [member])
        }}>
        <option value="">+</option>
        {addable.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        <option value="__new__">{t('groups.newEllipsis')}</option>
      </select>
    </span>
  )
}
