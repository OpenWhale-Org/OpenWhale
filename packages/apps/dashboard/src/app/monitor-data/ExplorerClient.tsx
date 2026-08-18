'use client'

import { useCallback, useEffect, useState } from 'react'

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
  return ts ? new Date(ts).toLocaleString() : '—'
}

export function ExplorerClient() {
  const [contracts, setContracts] = useState<ContractEntry[]>([])
  const [dataDir, setDataDir] = useState('')
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
      const data = await res.json() as { dataDir: string; contracts: ContractEntry[] }
      setContracts(data.contracts.sort((a, b) => a.monitor.localeCompare(b.monitor)))
      setDataDir(data.dataDir)
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
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'open failed')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-mono truncate" style={{ color: 'var(--muted)' }} title={dataDir}>{dataDir}</span>
        <button
          onClick={() => void openFolder()}
          className="text-xs px-3 py-1.5 rounded-md shrink-0"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
        >
          ⌘ Open data folder
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
        className="grid gap-3"
        style={{
          gridTemplateColumns: '220px 280px 1fr',
          height: 'calc(100vh - 15rem)', minHeight: 420,
        }}
      >
        {/* Contracts */}
        <div className="rounded-lg overflow-hidden flex flex-col" style={panelStyle}>
          <div className="px-3 py-2 text-xs font-medium shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            Contracts ({contracts.length})
          </div>
          {/* min-h-0 is what lets a flex child actually shrink and scroll — its
              default min-height:auto makes it grow to fit instead. */}
          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {contracts.length === 0 && (
            <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>No data yet — watch something first.</p>
          )}
          {contracts.map(c => (
            <button
              key={c.monitor}
              onClick={() => setMonitor(c.monitor)}
              className="w-full text-left px-3 py-2 text-sm"
              style={{
                background: monitor === c.monitor ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                borderLeft: `2px solid ${monitor === c.monitor ? 'var(--accent)' : 'transparent'}`,
              }}
            >
              <div className="font-mono text-xs">{c.monitor}</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{c.keys} keys · {formatBytes(c.bytes)}</div>
            </button>
          ))}
          </div>
        </div>

        {/* Keys */}
        <div className="rounded-lg overflow-hidden flex flex-col" style={panelStyle}>
          <div className="px-3 py-2 text-xs font-medium flex items-center justify-between shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            <span>Keys {monitor ? `(${keys.length})` : ''}</span>
            {monitor && (
              <button onClick={() => void openFolder(monitor)} className="text-xs underline" style={{ color: 'var(--muted)' }}>
                open folder
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {!monitor && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>Pick a contract.</p>}
          {monitor && keys.map(k => (
            <button
              key={k.key}
              onClick={() => setSelectedKey(k.key)}
              className="w-full text-left px-3 py-2"
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
            <span className="flex-1 font-mono truncate">{selectedKey ? `${monitor} / ${selectedKey}` : 'Records'}</span>
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
            {!selectedKey && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>Pick a key.</p>}
            {selectedKey && records === null && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>Loading…</p>}
            {selectedKey && records?.length === 0 && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>Empty file.</p>}
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
