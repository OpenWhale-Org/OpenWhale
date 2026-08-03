import type { AccountSnapshotRecord, AccountSnapshotStore } from '../types/account.js'
import type { DatabaseAdapter, Row } from '../database/DatabaseAdapter.js'

interface SnapshotRow extends Row {
  account: string
  ts: number
  equity: number
  available: number | null
  unrealized_pnl: number | null
}

function rowToRecord(row: SnapshotRow): AccountSnapshotRecord {
  return {
    account: row.account,
    ts: row.ts,
    equity: row.equity,
    ...(row.available !== null ? { available: row.available } : {}),
    ...(row.unrealized_pnl !== null ? { unrealizedPnl: row.unrealized_pnl } : {}),
  }
}

/** DB-backed equity snapshots (the `account_snapshots` table). */
export class DBAccountSnapshotStore implements AccountSnapshotStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async append(record: AccountSnapshotRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO account_snapshots (account, ts, equity, available, unrealized_pnl)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, ts) DO NOTHING`,
      [record.account, record.ts, record.equity, record.available ?? null, record.unrealizedPnl ?? null]
    )
  }

  async series(account: string, sinceTs: number): Promise<AccountSnapshotRecord[]> {
    const rows = await this.db.all<SnapshotRow>(
      'SELECT * FROM account_snapshots WHERE account = ? AND ts >= ? ORDER BY ts ASC',
      [account, sinceTs]
    )
    return rows.map(rowToRecord)
  }

  async latest(): Promise<AccountSnapshotRecord[]> {
    const rows = await this.db.all<SnapshotRow>(
      `SELECT s.* FROM account_snapshots s
       JOIN (SELECT account, MAX(ts) AS ts FROM account_snapshots GROUP BY account) m
         ON s.account = m.account AND s.ts = m.ts`
    )
    return rows.map(rowToRecord)
  }

  async clear(account: string): Promise<void> {
    await this.db.run('DELETE FROM account_snapshots WHERE account = ?', [account])
  }

  async prune(beforeTs: number): Promise<void> {
    await this.db.run('DELETE FROM account_snapshots WHERE ts < ?', [beforeTs])
  }
}

/** In-memory snapshots for runtimes without a database. */
export class MemoryAccountSnapshotStore implements AccountSnapshotStore {
  private readonly records: AccountSnapshotRecord[] = []

  async append(record: AccountSnapshotRecord): Promise<void> {
    this.records.push({ ...record })
  }

  async series(account: string, sinceTs: number): Promise<AccountSnapshotRecord[]> {
    return this.records.filter(r => r.account === account && r.ts >= sinceTs).sort((a, b) => a.ts - b.ts)
  }

  async latest(): Promise<AccountSnapshotRecord[]> {
    const byAccount = new Map<string, AccountSnapshotRecord>()
    for (const r of this.records) {
      const prev = byAccount.get(r.account)
      if (!prev || r.ts > prev.ts) byAccount.set(r.account, r)
    }
    return Array.from(byAccount.values())
  }

  async clear(account: string): Promise<void> {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]!.account === account) this.records.splice(i, 1)
    }
  }

  async prune(beforeTs: number): Promise<void> {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]!.ts < beforeTs) this.records.splice(i, 1)
    }
  }
}
