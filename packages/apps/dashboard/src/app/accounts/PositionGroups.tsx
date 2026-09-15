'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
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
  const [newName, setNewName] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{t('groups.title')}</span>
        {data && <span className="text-xs font-mono" style={{ color: tone(total) }}>{t('groups.totalPnl')} {signedUsd(total)}</span>}
        <span className="flex-1" />
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (!newName.trim()) return; void act(createGroup(newName.trim())); setNewName('') }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('groups.newPlaceholder')}
            className="h-8 px-2 rounded-md text-xs" style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)', width: '11rem' }} />
          <button type="submit" className="h-8 px-3 rounded-md text-xs" style={{ background: 'var(--accent)', color: '#fff' }}>{t('groups.create')}</button>
        </form>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />{t('groups.showHidden')}
        </label>
        <button onClick={() => void load()} className="w-8 h-8 rounded-md text-base" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }} title={t('groups.refresh')}>↻</button>
      </div>
      {error && <p className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{error}</p>}
      {!data && <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('common.loading')}</p>}
      {data?.length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('groups.empty')}</p>}
      {data?.map(g => (
        <GroupCard key={g.id} g={g} accounts={accounts} collapsed={collapsed.has(g.id)}
          onToggle={() => setCollapsed(prev => { const n = new Set(prev); if (!n.delete(g.id)) n.add(g.id); return n })}
          onAct={act} />
      ))}
    </div>
  )
}

function GroupCard({ g, accounts, collapsed, onToggle, onAct }: {
  g: LiveGroup; accounts: string[]; collapsed: boolean; onToggle: () => void; onAct: (p: Promise<string | undefined>) => Promise<void>
}) {
  const t = useT()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(g.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const manual = g.source === 'manual'
  const base = `/api/position-groups/${encodeURIComponent(g.id)}`

  return (
    <div className="rounded-lg" style={{ border: '1px solid var(--border)', opacity: g.hidden ? 0.6 : 1 }}>
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer flex-wrap" onClick={onToggle}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>{collapsed ? '▸' : '▾'}</span>
        {renaming ? (
          <form onClick={e => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); setRenaming(false); void onAct(api(base, 'PATCH', { name })) }}>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={() => setRenaming(false)}
              className="h-7 px-2 rounded text-sm" style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }} />
          </form>
        ) : <span className="text-sm font-medium">{g.name}</span>}
        <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--border) 60%, transparent)', color: 'var(--muted)' }}>
          {manual ? t('groups.manual') : t('groups.strategy')}
        </span>
        {g.instanceId && <Link href={`/instances/${encodeURIComponent(g.instanceId)}`} onClick={e => e.stopPropagation()} className="text-[11px]" style={{ color: 'var(--accent)' }}>{t('groups.openInstance')}</Link>}
        <span className="flex-1" />
        <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{t('groups.legs', { n: g.totals.open })} · {t('groups.gross')} {usd(g.totals.gross)} · {t('groups.net')} {signedUsd(g.totals.net)}</span>
        <span className="text-sm font-mono min-w-[6rem] text-right" style={{ color: tone(g.totals.pnl) }}>{signedUsd(g.totals.pnl)}</span>
        <span className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          {manual && <button className="text-xs px-1.5" style={{ color: 'var(--muted)' }} onClick={() => { setName(g.name); setRenaming(true) }}>{t('groups.rename')}</button>}
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
          <table className="w-full text-xs" style={{ minWidth: '28rem' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="text-left py-1 font-medium">{t('groups.col.account')}</th>
                <th className="text-left py-1 font-medium">{t('accounts.col.symbol')}</th>
                <th className="text-left py-1 font-medium">{t('accounts.col.side')}</th>
                <th className="text-right py-1 font-medium">{t('accounts.col.value')}</th>
                <th className="text-right py-1 font-medium">{t('accounts.col.upnl')}</th>
                {manual && <th />}
              </tr>
            </thead>
            <tbody>
              {g.members.flatMap(m => {
                const remove = manual
                  ? <td className="text-right"><button className="px-1" style={{ color: 'var(--muted)' }} title={t('groups.removeMember')} onClick={() => void onAct(api(`${base}/members`, 'DELETE', m))}>×</button></td>
                  : null
                if (m.rows.length === 0) {
                  return [<tr key={`${m.account}|${m.symbol}|${m.side}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="py-1">{m.account}</td><td className="py-1 font-mono">{m.symbol}</td>
                    <td className="py-1" style={{ color: 'var(--muted)' }}>{m.side === '*' ? t('groups.anySide') : m.side}</td>
                    <td colSpan={2} className="py-1 text-right" style={{ color: m.error ? 'var(--danger, #ef4444)' : 'var(--muted)' }}>{m.error ?? t('groups.flat')}</td>
                    {remove}
                  </tr>]
                }
                return m.rows.map((r, i) => (
                  <tr key={`${m.account}|${m.symbol}|${m.side}|${r.side}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="py-1">{i === 0 ? m.account : ''}</td>
                    <td className="py-1 font-mono">{i === 0 ? m.symbol : ''}</td>
                    <td className="py-1" style={{ color: r.side === 'long' ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>{r.side}</td>
                    <td className="py-1 text-right font-mono">{usd(r.value)}</td>
                    <td className="py-1 text-right font-mono" style={{ color: tone(r.pnl) }}>{signedUsd(r.pnl)}</td>
                    {i === 0 ? remove : manual ? <td /> : null}
                  </tr>
                ))
              })}
            </tbody>
          </table>
          {manual && <AddMember accounts={accounts} onAdd={(m) => onAct(addToGroup(g.id, [m]))} />}
        </div>
      )}
    </div>
  )
}

/** Pick an account, then one of its positions (or type a contract), then a side. */
function AddMember({ accounts, onAdd }: { accounts: string[]; onAdd: (m: Member) => Promise<void> }) {
  const t = useT()
  const [account, setAccount] = useState('')
  const [positions, setPositions] = useState<Array<{ id: string; side: string; value: number }>>([])
  const [symbol, setSymbol] = useState('')
  const [side, setSide] = useState<Side>('*')
  useEffect(() => {
    setPositions([]); setSymbol('')
    if (!account) return
    let gone = false
    void fetch(`/api/accounts/${encodeURIComponent(account)}/detail`).then(r => (r.ok ? r.json() : null))
      .then((d: { sections?: { positions?: Array<{ id: string; side: string; value: number }> } } | null) => { if (!gone) setPositions(d?.sections?.positions ?? []) })
      .catch(() => {})
    return () => { gone = true }
  }, [account])
  const symbols = [...new Set(positions.map(p => p.id))]
  return (
    <div className="flex items-center gap-2 mt-2 flex-wrap">
      <Select size="sm" value={account} onChange={setAccount} placeholder={t('groups.pickAccount')} style={{ minWidth: '10rem' }}
        options={accounts.map(a => ({ value: a, label: a }))} />
      <Select size="sm" value={symbol} onChange={setSymbol} placeholder={t('groups.pickPosition')} style={{ minWidth: '14rem' }} disabled={!account}
        options={symbols.map(s => ({ value: s, label: s, hint: positions.filter(p => p.id === s).map(p => `${p.side} ${usd(Math.abs(p.value))}`).join(' / ') }))} />
      <Select size="sm" value={side} onChange={(v) => setSide(v as Side)} style={{ minWidth: '7rem' }}
        options={[{ value: '*', label: t('groups.anySide') }, { value: 'long', label: 'long' }, { value: 'short', label: 'short' }]} />
      <button disabled={!account || !symbol} className="h-8 px-3 rounded-md text-xs" style={{ border: '1px solid var(--border)', color: 'var(--foreground)', opacity: !account || !symbol ? 0.5 : 1 }}
        onClick={() => { void onAdd({ account, symbol, side }); setSymbol('') }}>{t('groups.addMember')}</button>
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
