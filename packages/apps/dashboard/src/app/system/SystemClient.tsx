'use client'

import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { Select } from '@/components/Select'
import { TIME_ZONES, activeTimeZone, resolvedTimeZone, writeTimeZoneCookie, fmtDateTime } from '@/lib/time'

/**
 * Engine-wide switches — the things that belong to no one instance.
 *
 * First among them the PnL collector: it queries every venue for fills and
 * funding on a timer and after every claimed order, and on a busy venue that
 * traffic competes with order placement for the same request budget. Pausing
 * it stops those queries; claims keep being recorded, and resuming sweeps once
 * to catch up. The choice survives restarts.
 */

interface CollectorStatus {
  paused: boolean
  collecting: boolean
  intervalMs: number
  lastCollectAt?: number
  lastCollectMs?: number
  unavailable?: boolean
}

export function SystemClient() {
  const t = useT()
  const [status, setStatus] = useState<CollectorStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pull = useCallback(async () => {
    try {
      const r = await fetch('/api/pnl/collector')
      if (r.ok) setStatus(await r.json() as CollectorStatus)
    } catch { /* keep what we had */ }
  }, [])

  useEffect(() => {
    void pull()
    const timer = setInterval(() => void pull(), 10_000)
    return () => clearInterval(timer)
  }, [pull])

  async function toggle() {
    if (!status) return
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/pnl/collector', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: !status.paused }),
      })
      const body = await r.json() as CollectorStatus & { error?: string }
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      setStatus(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function collectNow() {
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/pnl/collect', { method: 'POST' })
      if (!r.ok) throw new Error(await r.text())
      await pull()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const running = status && !status.paused
  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold mb-1">{t('system.title')}</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>{t('system.subtitle')}</p>
      </div>

      <section className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">{t('system.pnl.title')}</h2>
              {status && !status.unavailable && (
                <span className="text-xs px-2 py-0.5 rounded-full"
                  style={running
                    ? { background: 'color-mix(in srgb, var(--success) 16%, transparent)', color: 'var(--success)' }
                    : { background: 'color-mix(in srgb, var(--warning) 16%, transparent)', color: 'var(--warning)' }}>
                  {running ? t('system.pnl.running') : t('system.pnl.paused')}
                </span>
              )}
              {status?.collecting && <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('system.pnl.collecting')}</span>}
            </div>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('system.pnl.desc')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !status || status.unavailable} onClick={() => void collectNow()}>
              {t('system.pnl.collectNow')}
            </button>
            <button type="button" disabled={busy || !status || status.unavailable} onClick={() => void toggle()}
              className={running ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'}>
              {busy ? '…' : running ? t('system.pnl.pause') : t('system.pnl.resume')}
            </button>
          </div>
        </div>

        {status && !status.unavailable && (
          <div className="grid gap-x-6 gap-y-1 text-xs" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <span style={{ color: 'var(--muted)' }}>{t('system.pnl.interval')}</span>
            <span className="font-mono">{Math.round(status.intervalMs / 60_000)} min</span>
            <span style={{ color: 'var(--muted)' }}>{t('system.pnl.last')}</span>
            <span className="font-mono">
              {status.lastCollectAt
                ? `${fmtDateTime(status.lastCollectAt)} · ${((status.lastCollectMs ?? 0) / 1000).toFixed(1)} s`
                : t('system.pnl.never')}
            </span>
          </div>
        )}
        {status?.paused && (
          <p className="text-xs rounded-md px-3 py-2" style={{ background: 'var(--surface-inset)', color: 'var(--warning)' }}>{t('system.pnl.pausedNote')}</p>
        )}
        {status?.unavailable && <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('system.pnl.unavailable')}</p>}
        {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
      </section>

      <TimeZoneCard />
    </div>
  )
}

/**
 * Which clock the dashboard reads in. Saved in a cookie and applied by a
 * reload — every rendered time changes at once, and the server renders the
 * next page in the same zone instead of in its own UTC.
 */
function TimeZoneCard() {
  const t = useT()
  const [zone, setZone] = useState('')
  const [now, setNow] = useState('')
  useEffect(() => {
    setZone(activeTimeZone())
    const tick = () => setNow(fmtDateTime(Date.now()))
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <section className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t('system.tz.title')}</h2>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('system.tz.desc')}</p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Select
          value={zone}
          onChange={(z) => { writeTimeZoneCookie(z); window.location.reload() }}
          options={TIME_ZONES.map(z => ({ value: z.id, label: z.label }))}
          style={{ minWidth: '18rem' }}
        />
        <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{resolvedTimeZone()} · {now}</span>
      </div>
    </section>
  )
}
