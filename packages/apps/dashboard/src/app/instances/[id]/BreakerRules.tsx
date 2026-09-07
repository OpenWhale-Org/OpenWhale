'use client'

import { useCallback, useEffect, useState } from 'react'
import type { BreakerRule } from '@openwhaleorg/core'
import { Switch } from '@/components/Switch'
import { Select } from '@/components/Select'
import { useT } from '@/i18n'

/**
 * The circuit breaker tiers.
 *
 * Each rule is laid out as a sentence rather than a form grid, because the
 * thing an operator has to get right here is the MEANING — "stop when net PnL
 * over 60 minutes is below −500" is checkable at a glance in a way that four
 * labelled boxes are not, and the cost of misreading one is a live instance
 * stopped, or not stopped.
 */

interface LedgerHealth { live: boolean; oldestMarkTs: number | null; pairs: number; stalePairs: number; reason?: string }
interface WindowRead { ruleId: string; windowMin: number; metric: string; observed: number | null; threshold: number; tripped: boolean }
interface BreakerStatus { enabled: boolean; rules: number; ledger: LedgerHealth; windows?: WindowRead[] }

type T = ReturnType<typeof useT>

const metricOptions = (t: T) => [
  { value: 'netPnl', label: t('breaker.metric.netPnl'), hint: t('breaker.metric.netPnlHint') },
  { value: 'winRate', label: t('breaker.metric.winRate'), hint: t('breaker.metric.winRateHint') },
]
const actionOptions = (t: T) => [
  { value: 'alert', label: t('breaker.action.alert'), hint: t('breaker.action.alertHint') },
  { value: 'deactivate', label: t('breaker.action.stop'), hint: t('breaker.action.stopHint') },
]

const num = { background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' } as const

function newRule(): BreakerRule {
  return { id: Math.random().toString(36).slice(2, 9), metric: 'netPnl', windowMin: 60, below: -100, action: 'alert' }
}

export function BreakerRules({ instanceId, enabled, rules, onChange }: {
  instanceId: string
  enabled: boolean
  rules: BreakerRule[]
  onChange: (next: { breakerEnabled: boolean; breaker: BreakerRule[] }) => void
}) {
  const t = useT()
  const METRICS = metricOptions(t)
  const ACTIONS = actionOptions(t)
  const [status, setStatus] = useState<BreakerStatus | null>(null)

  const loadStatus = useCallback(async () => {
    const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/breaker`)
    setStatus(res.ok ? (await res.json()) as BreakerStatus : null)
  }, [instanceId])

  useEffect(() => { if (enabled) void loadStatus() }, [enabled, loadStatus])

  const set = (i: number, patch: Partial<BreakerRule>) =>
    onChange({ breakerEnabled: enabled, breaker: rules.map((r, n) => (n === i ? { ...r, ...patch } : r)) })

  return (
    <div>
      <Switch
        checked={enabled}
        onChange={on => onChange({ breakerEnabled: on, breaker: rules.length > 0 ? rules : on ? [newRule()] : [] })}
        label={t('breaker.title')}
        hint={<>
          {t('breaker.hint')}
          {' '}<b>{t('breaker.hintAbstain')}</b>{t('breaker.hintAbstainWhy')}
        </>}
      />

      {enabled && (
        <div className="ml-7 mt-2 flex flex-col gap-2">
          {rules.length === 0 && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('breaker.noTiers')}</span>
          )}

          {rules.map((r, i) => {
            const read = status?.windows?.find(w => w.ruleId === r.id)
            return (
              <div key={r.id} className="rounded-md p-2 flex flex-col gap-1.5"
                   style={{ background: 'var(--background)', border: `1px solid ${read?.tripped ? 'var(--danger)' : 'var(--border)'}` }}>
                <div className="flex items-center gap-1.5 flex-wrap text-xs">
                  <div style={{ width: 96 }}>
                    <Select size="sm" value={r.action} options={ACTIONS} onChange={v => set(i, { action: v as BreakerRule['action'] })} />
                  </div>
                  <span style={{ color: 'var(--muted)' }}>{t('breaker.when')}</span>
                  <div style={{ width: 110 }}>
                    <Select size="sm" value={r.metric} options={METRICS} onChange={v => set(i, { metric: v as BreakerRule['metric'] })} />
                  </div>
                  <span style={{ color: 'var(--muted)' }}>{t('breaker.over')}</span>
                  <input type="number" min={1} value={r.windowMin} onChange={e => set(i, { windowMin: Number(e.target.value) })}
                         className="px-1.5 py-1 rounded text-xs mono" style={{ ...num, width: 64 }} />
                  <span style={{ color: 'var(--muted)' }}>{t('breaker.minIsBelow')}</span>
                  <input type="number" value={r.below} onChange={e => set(i, { below: Number(e.target.value) })}
                         className="px-1.5 py-1 rounded text-xs mono" style={{ ...num, width: 80 }} />
                  <span style={{ color: 'var(--muted)' }}>{r.metric === 'winRate' ? '%' : ''}</span>
                  <button onClick={() => onChange({ breakerEnabled: enabled, breaker: rules.filter((_, n) => n !== i) })}
                          className="ml-auto px-1.5 py-0.5 rounded text-xs" style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>
                    ✕
                  </button>
                </div>

                <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                  {r.metric === 'winRate' && (
                    <label className="flex items-center gap-1">
                      {t('breaker.holdUntil')}
                      <input type="number" min={0} value={r.minSamples ?? 10} onChange={e => set(i, { minSamples: Number(e.target.value) })}
                             className="px-1 py-0.5 rounded mono" style={{ ...num, width: 52 }} />
                      {t('breaker.closes')}
                    </label>
                  )}
                  {r.action === 'alert' && (
                    <label className="flex items-center gap-1">
                      {t('breaker.repeatAtMostEvery')}
                      <input type="number" min={0} value={r.cooldownMin ?? 60} onChange={e => set(i, { cooldownMin: Number(e.target.value) })}
                             className="px-1 py-0.5 rounded mono" style={{ ...num, width: 52 }} />
                      {t('breaker.min')}
                    </label>
                  )}
                  {read && (
                    <span className="ml-auto mono" style={{ color: read.tripped ? 'var(--danger)' : 'var(--muted)' }}>
                      {t('breaker.now', { value: read.observed === null ? t('breaker.notEnoughData') : read.observed.toFixed(2) })}
                      {read.metric === 'winRate' && read.observed !== null ? '%' : ''}
                      {read.tripped ? t('breaker.tripped') : ''}
                    </span>
                  )}
                </div>
              </div>
            )
          })}

          <div className="flex items-center gap-2">
            <button onClick={() => onChange({ breakerEnabled: enabled, breaker: [...rules, newRule()] })}
                    className="text-xs px-2 py-1 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
              {t('breaker.addTier')}
            </button>
            <button onClick={() => void loadStatus()} className="text-xs px-2 py-1 rounded-md"
                    style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
              {t('breaker.reread')}
            </button>

            {/* The blind case is the one worth shouting about: a safety net
                that is quietly not watching is worse than none, because you
                stop checking by hand. */}
            {status && (
              status.ledger.live
                ? <span className="text-xs" style={{ color: 'var(--success)' }}>
                    {t('breaker.ledgerLive', { n: status.ledger.pairs })}
                  </span>
                : <span className="text-xs" style={{ color: 'var(--warning)' }}>
                    {t('breaker.notWatching', { reason: status.ledger.reason ?? t('breaker.ledgerNotLive') })}
                  </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
