import { randomUUID } from 'crypto'
import type { OpenWhaleRuntime, SQLiteAdapter } from '@openwhaleorg/core'

/**
 * Position combinations: several positions — across accounts and venues — read
 * as one trade with one PnL.
 *
 * An arbitrage is rarely one position. An ETF pair is two contracts; a
 * cross-venue spread is the same contract on two exchanges. On the Accounts
 * page each leg is a line in a different account's table, and whether the
 * trade is winning is a sum the operator did in their head.
 *
 * A member is (account, symbol, side). Side '*' matches whichever side is held
 * — a strategy that trades both directions does not know in advance.
 *
 * A combination may carry a start date. The positions are current either way;
 * the date is about the ledger: a combination reusing a contract traded before
 * (or an instance restarted on a new thesis) would otherwise count history that
 * was never part of this trade. Dates are read as UTC midnight — the ledger's
 * clock, not the browser's.
 *
 * Two sources. `manual` combinations are the operator's. `instance`
 * combinations are derived: a strategy that declares positionLegs() gets one
 * combination per instance, kept in step with its bindings and params on every
 * read, and removed with the instance. The operator can hide those but not
 * edit their members — the next sync would put them back.
 */

export type Side = 'long' | 'short' | '*'
export interface Member { account: string; symbol: string; side: Side }
export interface Group {
  id: string
  name: string
  source: 'manual' | 'instance'
  instanceId?: string
  hidden: boolean
  sortOrder: number
  /** `YYYY-MM-DD`; history before this day (UTC) is not this combination's. */
  startAt?: string
  members: Member[]
}

export interface LiveRow { side: 'long' | 'short'; value: number; pnl: number }
export interface LiveMember extends Member { rows: LiveRow[]; error?: string }
export interface LiveGroup extends Group {
  members: LiveMember[]
  totals: { gross: number; net: number; pnl: number; open: number }
}

type Db = Pick<SQLiteAdapter, 'run' | 'get' | 'all'>
type Rt = Pick<OpenWhaleRuntime, 'listInstanceViews' | 'listAccounts' | 'accountDetail' | 'instancePositionLegs'>

export class PositionGroups {
  private ready = false

  constructor(private readonly db: Db, private readonly runtime: Rt) {}

  private async ensure(): Promise<void> {
    if (this.ready) return
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS position_groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        source      TEXT NOT NULL,
        instance_id TEXT,
        hidden      INTEGER NOT NULL DEFAULT 0,
        -- 1 = hidden 跟着实例状态走，操作员没表过态（见 syncInstances）
        hidden_auto INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        start_at    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`)
    // Additive migration for combinations created before the start date.
    // Asked first rather than run-and-swallow: every read selects start_at, so
    // an ALTER that failed for any reason other than "already there" (a write
    // lock, say) must not leave the schema marked ready — that would 500 the
    // whole panel for the life of the process. Failing here retries next call.
    const columns = await this.db.all<{ name: string }>('PRAGMA table_info(position_groups)')
    if (!columns.some(c => c.name === 'start_at')) await this.db.run('ALTER TABLE position_groups ADD COLUMN start_at TEXT')
    /* 1 = 这一行的 hidden 是同步按实例状态给的，操作员还没表过态。同上，
       先问再加。 */
    if (!columns.some(c => c.name === 'hidden_auto')) {
      await this.db.run('ALTER TABLE position_groups ADD COLUMN hidden_auto INTEGER NOT NULL DEFAULT 0')
    }
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS position_group_members (
        group_id TEXT NOT NULL,
        account  TEXT NOT NULL,
        symbol   TEXT NOT NULL,
        side     TEXT NOT NULL,
        PRIMARY KEY (group_id, account, symbol, side)
      )`)
    this.ready = true
  }

  /** Every combination, strategy-derived ones brought up to date first. */
  async list(): Promise<Group[]> {
    await this.ensure()
    await this.syncInstances()
    const rows = await this.db.all<{ id: string; name: string; source: string; instance_id: string | null; hidden: number; sort_order: number; start_at: string | null }>(
      'SELECT id, name, source, instance_id, hidden, sort_order, start_at FROM position_groups ORDER BY sort_order, created_at')
    const members = await this.db.all<{ group_id: string; account: string; symbol: string; side: string }>(
      'SELECT group_id, account, symbol, side FROM position_group_members ORDER BY account, symbol, side')
    return rows.map(r => ({
      id: r.id, name: r.name, source: r.source === 'instance' ? 'instance' : 'manual',
      ...(r.instance_id ? { instanceId: r.instance_id } : {}),
      hidden: r.hidden === 1, sortOrder: r.sort_order,
      ...(r.start_at ? { startAt: r.start_at } : {}),
      members: members.filter(m => m.group_id === r.id).map(m => ({ account: m.account, symbol: m.symbol, side: asSide(m.side) })),
    }))
  }

  /**
   * One combination per instance whose strategy declares its legs. The legs
   * name credentials; a combination needs accounts, so each is mapped to the
   * perp account(s) bound to that credential.
   */
  private async syncInstances(): Promise<void> {
    const [instances, accounts] = await Promise.all([
      this.runtime.listInstanceViews().catch(() => []),
      this.runtime.listAccounts().catch(() => []),
    ])
    const accountsOf = (credential: string) => accounts
      .filter(a => a.credential === credential && (a.kind === undefined || String(a.kind).endsWith('/perp')))
      .map(a => a.name)
    const now = new Date().toISOString()
    const live = new Set<string>()
    for (const inst of instances) {
      const legs = this.runtime.instancePositionLegs(inst)
      if (legs.length === 0) continue
      const members: Member[] = legs.flatMap(l => accountsOf(l.credential).map(account => ({ account, symbol: l.symbol, side: l.side ?? '*' as Side })))
      if (members.length === 0) continue
      const id = `instance:${inst.id}`
      live.add(id)
      /* 停着的实例，它的组合默认收起来：那些腿多半已经平了，留在列表里只是
         每秒重复一次「无持仓」。默认而已——操作员在卡片上点过隐藏/取消隐藏
         之后（`hidden_auto` 归 0），这里就不再插手，实例再停也不动它。
         sort_order 一直是操作员的。 */
      const hidden = inst.active === false ? 1 : 0
      await this.db.run(
        `INSERT INTO position_groups (id, name, source, instance_id, hidden, hidden_auto, sort_order, created_at, updated_at)
         VALUES (?, ?, 'instance', ?, ?, 1, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           hidden = CASE WHEN position_groups.hidden_auto = 1 THEN excluded.hidden ELSE position_groups.hidden END,
           updated_at = excluded.updated_at`,
        [id, inst.name, inst.id, hidden, now, now])
      await this.db.run('DELETE FROM position_group_members WHERE group_id = ?', [id])
      for (const m of uniq(members)) {
        await this.db.run('INSERT OR IGNORE INTO position_group_members (group_id, account, symbol, side) VALUES (?, ?, ?, ?)', [id, m.account, m.symbol, m.side])
      }
    }
    const stale = await this.db.all<{ id: string }>("SELECT id FROM position_groups WHERE source = 'instance'")
    for (const { id } of stale) {
      if (live.has(id)) continue
      await this.db.run('DELETE FROM position_group_members WHERE group_id = ?', [id])
      await this.db.run('DELETE FROM position_groups WHERE id = ?', [id])
    }
  }

  async create(name: string, members: Member[] = [], startAt?: string | null): Promise<Group> {
    await this.ensure()
    const id = randomUUID()
    const now = new Date().toISOString()
    const max = await this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM position_groups')
    await this.db.run(
      "INSERT INTO position_groups (id, name, source, hidden, sort_order, start_at, created_at, updated_at) VALUES (?, ?, 'manual', 0, ?, ?, ?, ?)",
      [id, name.trim() || '未命名组合', (max?.m ?? 0) + 1, asDate(startAt), now, now])
    await this.addMembers(id, members)
    return (await this.list()).find(g => g.id === id)!
  }

  async update(id: string, patch: { name?: string; hidden?: boolean; sortOrder?: number; startAt?: string | null }): Promise<void> {
    const g = await this.require(id)
    const now = new Date().toISOString()
    if (patch.name !== undefined && g.source === 'manual') await this.db.run('UPDATE position_groups SET name = ?, updated_at = ? WHERE id = ?', [patch.name.trim() || g.name, now, id])
    // 点过一次隐藏/取消隐藏，这一行的 hidden 就是操作员的了，同步不再改它
    if (patch.hidden !== undefined) await this.db.run('UPDATE position_groups SET hidden = ?, hidden_auto = 0, updated_at = ? WHERE id = ?', [patch.hidden ? 1 : 0, now, id])
    if (patch.sortOrder !== undefined) await this.db.run('UPDATE position_groups SET sort_order = ?, updated_at = ? WHERE id = ?', [Math.round(patch.sortOrder), now, id])
    // The start date is the operator's on BOTH sources: an instance decides its
    // members, but when its history begins is a judgement about the trade.
    if (patch.startAt !== undefined) await this.db.run('UPDATE position_groups SET start_at = ?, updated_at = ? WHERE id = ?', [asDate(patch.startAt), now, id])
  }

  async remove(id: string): Promise<void> {
    const g = await this.require(id)
    if (g.source !== 'manual') throw new Error('策略生成的组合随实例存在，不能删除，可以隐藏')
    await this.db.run('DELETE FROM position_group_members WHERE group_id = ?', [id])
    await this.db.run('DELETE FROM position_groups WHERE id = ?', [id])
  }

  async addMembers(id: string, members: Member[]): Promise<void> {
    const g = await this.require(id)
    if (g.source !== 'manual') throw new Error('策略生成的组合由实例决定成员，不能手动修改')
    for (const m of uniq(members.map(normalize))) {
      await this.db.run('INSERT OR IGNORE INTO position_group_members (group_id, account, symbol, side) VALUES (?, ?, ?, ?)', [id, m.account, m.symbol, m.side])
    }
  }

  async removeMember(id: string, member: Member): Promise<void> {
    const g = await this.require(id)
    if (g.source !== 'manual') throw new Error('策略生成的组合由实例决定成员，不能手动修改')
    const m = normalize(member)
    await this.db.run('DELETE FROM position_group_members WHERE group_id = ? AND account = ? AND symbol = ? AND side = ?', [id, m.account, m.symbol, m.side])
  }

  private async require(id: string): Promise<Group> {
    const g = (await this.list()).find(x => x.id === id)
    if (!g) throw new Error(`没有这个组合：${id}`)
    return g
  }

  /**
   * Combinations with what their members hold right now. Each account is read
   * once, however many combinations name it; an account that cannot be read
   * marks its members rather than failing the whole answer.
   */
  async live(opts: { includeHidden?: boolean } = {}): Promise<{ groups: LiveGroup[] }> {
    const groups = (await this.list()).filter(g => opts.includeHidden || !g.hidden)
    const names = [...new Set(groups.flatMap(g => g.members.map(m => m.account)))]
    const detail = new Map<string, { rows: Array<{ id: string; side: string; value: number; pnl: number }>; error?: string }>()
    await Promise.all(names.map(async (name) => {
      try {
        const d = await this.runtime.accountDetail(name)
        const rows = (d.sections['positions'] as Array<{ id: string; side: string; value: number; pnl: number }> | undefined) ?? []
        detail.set(name, { rows, ...(d.errors['positions'] ? { error: d.errors['positions'] } : {}) })
      } catch (err) {
        detail.set(name, { rows: [], error: err instanceof Error ? err.message : String(err) })
      }
    }))
    return { groups: groups.map(g => liveOf(g, detail)) }
  }
}

export function liveOf(g: Group, detail: Map<string, { rows: Array<{ id: string; side: string; value: number; pnl: number }>; error?: string }>): LiveGroup {
  const members: LiveMember[] = g.members.map((m) => {
    const d = detail.get(m.account)
    const rows = (d?.rows ?? [])
      .filter(r => r.id === m.symbol && (m.side === '*' || r.side === m.side))
      .map(r => ({ side: (r.side === 'short' ? 'short' : 'long') as 'long' | 'short', value: Math.abs(Number(r.value) || 0), pnl: Number(r.pnl) || 0 }))
    return { ...m, rows, ...(d?.error ? { error: d.error } : {}) }
  })
  const all = members.flatMap(m => m.rows)
  return {
    ...g, members,
    totals: {
      gross: all.reduce((n, r) => n + r.value, 0),
      net: all.reduce((n, r) => n + (r.side === 'long' ? r.value : -r.value), 0),
      pnl: all.reduce((n, r) => n + r.pnl, 0),
      open: all.length,
    },
  }
}

/** `YYYY-MM-DD` or null. Anything else — including a full ISO timestamp — is cut to its date. */
export function asDate(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null
  return m ? m[1]! : null
}

/** A combination's start date as a ledger timestamp (UTC midnight), if it has one. */
export function startMsOf(startAt?: string): number | undefined {
  const date = asDate(startAt)
  if (!date) return undefined
  const ms = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : undefined
}

function asSide(s: string): Side {
  return s === 'long' || s === 'short' ? s : '*'
}

function normalize(m: Member): Member {
  return { account: String(m.account), symbol: String(m.symbol), side: asSide(String(m.side)) }
}

function uniq(ms: Member[]): Member[] {
  const seen = new Set<string>()
  return ms.filter(m => { const k = `${m.account} ${m.symbol} ${m.side}`; if (seen.has(k)) return false; seen.add(k); return true })
}
