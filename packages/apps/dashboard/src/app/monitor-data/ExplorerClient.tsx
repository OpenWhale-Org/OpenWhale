'use client'

import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { fmtDateTime } from '@/lib/time'

interface ContractEntry { monitor: string; keys: number; bytes: number }
interface KeyEntry { key: string; bytes: number; updatedAt: number }
interface DataRecord { ts?: number; data?: unknown; [k: string]: unknown }

const panelStyle = { background: 'var(--surface)', border: '1px solid var(--border)' } as const
const LIMITS = [50, 100, 500] as const

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatTime(ts?: number): string {
  return ts ? fmtDateTime(ts) : '—'
}

export function ExplorerClient() {
  const t = useT()
  const [contracts, setContracts] = useState<ContractEntry[]>([])
  const [dataDir, setDataDir] = useState('')
  const [disk, setDisk] = useState<{ freeBytes: number; totalBytes: number } | null>(null)
  const [monitor, setMonitor] = useState<string | null>(null)
  const [keys, setKeys] = useState<KeyEntry[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [records, setRecords] = useState<DataRecord[] | null>(null)
  const [limit, setLimit] = useState<number>(100)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [error, setError] = useState('')

  const loadContracts = useCallback(async () => {
    const res = await fetch('/api/monitor-data')
    if (res.ok) {
      const data = await res.json() as { dataDir: string; contracts: ContractEntry[]; disk?: { freeBytes: number; totalBytes: number } }
      setContracts(data.contracts.sort((a, b) => a.monitor.localeCompare(b.monitor)))
      setDataDir(data.dataDir)
      setDisk(data.disk ?? null)
    }
  }, [])

  useEffect(() => { void loadContracts() }, [loadContracts])

  useEffect(() => {
    if (!monitor) return
    setKeys([]); setSelectedKey(null); setRecords(null)
    void fetch(`/api/monitor-data?monitor=${encodeURIComponent(monitor)}`)
      .then(r => r.json() as Promise<{ keys: KeyEntry[] }>)
      .then(d => setKeys(d.keys))
  }, [monitor])

  const loadRecords = useCallback(async () => {
    if (!monitor || !selectedKey) return
    setRecords(null)
    const res = await fetch(`/api/monitor-data?monitor=${encodeURIComponent(monitor)}&key=${encodeURIComponent(selectedKey)}&limit=${limit}`)
    if (res.ok) setRecords(((await res.json()) as { records: DataRecord[] }).records)
  }, [monitor, selectedKey, limit])

  useEffect(() => { void loadRecords() }, [loadRecords])

  async function openFolder(target?: string) {
    setError('')
    const res = await fetch('/api/monitor-data/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target ? { monitor: target } : {}),
    })
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? t('explorer.openFailed'))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-mono truncate" style={{ color: 'var(--muted)' }} title={dataDir}>{dataDir}</span>
        {/* These files only grow, so the totals above are half a question —
            what is left is the other half. The bar turns amber under 15% and
            red under 5%: by the time a collector cannot write, the data it
            missed is gone for good. */}
        {disk && (() => {
          const collected = contracts.reduce((n, c) => n + c.bytes, 0)
          const usedFrac = 1 - disk.freeBytes / disk.totalBytes
          const tight = disk.freeBytes / disk.totalBytes
          const tone = tight < 0.05 ? 'var(--danger)' : tight < 0.15 ? 'var(--warning, #eab308)' : 'var(--accent)'
          return (
            <div
              className="flex items-center gap-2.5 shrink-0 text-xs"
              title={t('explorer.diskTitle', { collected: formatBytes(collected), free: formatBytes(disk.freeBytes), total: formatBytes(disk.totalBytes) })}
            >
              <span style={{ color: 'var(--muted)' }}>
                {t('explorer.monitors')} <span style={{ color: 'var(--foreground)' }}>{formatBytes(collected)}</span>
              </span>
              <div className="rounded-full overflow-hidden" style={{ width: 88, height: 6, background: 'var(--background)', border: '1px solid var(--border)' }}>
                <div style={{ width: `${Math.min(100, usedFrac * 100).toFixed(1)}%`, height: '100%', background: tone }} />
              </div>
              <span style={{ color: tight < 0.15 ? tone : 'var(--muted)' }}>
                {t('explorer.free', { free: formatBytes(disk.freeBytes) })}
              </span>
            </div>
          )
        })()}
        <button
          onClick={() => void openFolder()}
          className="text-xs px-3 py-1.5 rounded-md shrink-0"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
        >
          {t('explorer.openDataFolder')}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md text-xs" style={{ background: 'color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)', color: 'var(--danger, #ef4444)' }}>
          {error}
        </div>
      )}

      {/* A definite height, so all three panels end on the same line and each
          scrolls inside itself. Without one the row was sized by whichever
          panel happened to be tallest, and the records list — capped at its own
          fixed maxHeight — left dead space below it. */}
      <div
        className="ow-explorer-grid grid gap-3"
        style={{
          gridTemplateColumns: '220px 280px 1fr',
          height: 'calc(100dvh - 15rem)', minHeight: 420,
        }}
      >
        {/* Contracts */}
        <div className="rounded-lg overflow-hidden flex flex-col" style={panelStyle}>
          <div className="px-3 py-2 text-xs font-medium shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            {t('explorer.contracts', { n: contracts.length })}
          </div>
          {/* min-h-0 is what lets a flex child actually shrink and scroll — its
              default min-height:auto makes it grow to fit instead. */}
          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {contracts.length === 0 && (
            <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>{t('explorer.noData')}</p>
          )}
          {contracts.map(c => (
            <button
              key={c.monitor}
              onClick={() => setMonitor(c.monitor)}
              className="hoverable hoverable-flat w-full text-left px-3 py-2 text-sm"
              style={{
                background: monitor === c.monitor ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                borderLeft: `2px solid ${monitor === c.monitor ? 'var(--accent)' : 'transparent'}`,
              }}
            >
              <div className="font-mono text-xs">{c.monitor}</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{t('explorer.keysBytes', { n: c.keys, bytes: formatBytes(c.bytes) })}</div>
            </button>
          ))}
          </div>
        </div>

        {/* Keys */}
        <div className="rounded-lg overflow-hidden flex flex-col" style={panelStyle}>
          <div className="px-3 py-2 text-xs font-medium flex items-center justify-between shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            <span>{monitor ? t('explorer.keysCount', { n: keys.length }) : t('explorer.keys')}</span>
            {monitor && (
              <button onClick={() => void openFolder(monitor)} className="text-xs underline" style={{ color: 'var(--muted)' }}>
                {t('explorer.openFolder')}
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {!monitor && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>{t('explorer.pickContract')}</p>}
          {monitor && keys.map(k => (
            <button
              key={k.key}
              onClick={() => setSelectedKey(k.key)}
              className="hoverable hoverable-flat w-full text-left px-3 py-2"
              style={{
                background: selectedKey === k.key ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                borderLeft: `2px solid ${selectedKey === k.key ? 'var(--accent)' : 'transparent'}`,
              }}
            >
              <div className="font-mono text-xs break-all">{k.key}</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{formatBytes(k.bytes)} · {formatTime(k.updatedAt)}</div>
            </button>
          ))}
          </div>
        </div>

        {/* Records */}
        <div className="rounded-lg overflow-hidden flex flex-col" style={panelStyle}>
          <div className="px-3 py-2 text-xs font-medium flex items-center gap-2 shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            <span className="flex-1 font-mono truncate">{selectedKey ? `${monitor} / ${selectedKey}` : t('explorer.records')}</span>
            {selectedKey && (
              <>
                {LIMITS.map(n => (
                  <button
                    key={n}
                    onClick={() => setLimit(n)}
                    className="px-1.5 py-0.5 rounded"
                    style={{
                      background: limit === n ? 'var(--accent)' : 'transparent',
                      color: limit === n ? '#fff' : 'var(--muted)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {n}
                  </button>
                ))}
                <button onClick={() => void loadRecords()} className="px-1.5 py-0.5 rounded" style={{ border: '1px solid var(--border)' }}>⟳</button>
              </>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
            {!selectedKey && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>{t('explorer.pickKey')}</p>}
            {selectedKey && records === null && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>{t('common.loading')}</p>}
            {selectedKey && records?.length === 0 && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>{t('explorer.emptyFile')}</p>}
            {records?.map((r, i) => {
              const payload = r.data !== undefined ? r.data : r
              const oneLine = JSON.stringify(payload)
              const isOpen = expanded === i
              return (
                <div key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : i)}
                    className="w-full text-left px-3 py-1.5 flex gap-3 items-baseline"
                  >
                    <span className="text-xs font-mono shrink-0" style={{ color: 'var(--muted)' }}>{formatTime(r.ts)}</span>
                    {!isOpen && (
                      <span className="text-xs font-mono truncate" style={{ color: 'var(--foreground)' }}>{oneLine}</span>
                    )}
                  </button>
                  {isOpen && (
                    <pre className="text-xs font-mono px-3 pb-2 overflow-x-auto" style={{ color: 'var(--foreground)' }}>
                      {JSON.stringify(payload, null, 2)}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
