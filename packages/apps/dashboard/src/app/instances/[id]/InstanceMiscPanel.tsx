'use client'

import { useEffect, useState } from 'react'
import type { StrategyInstanceView, StrategyDefinition, InstanceOptions } from '@openwhaleorg/core'

/**
 * The switches that belong to the ENGINE rather than to the strategy.
 *
 * Separate from the Parameters panel because they save differently and mean
 * differently: params are the strategy's own configuration, read once at
 * activation, so changing one restarts the instance. These take effect on the
 * next trigger, which is the entire point of the dry-run one — a stop switch
 * you can only reach by restarting the thing you are trying to stop is not a
 * stop switch.
 */

interface ExecutorStatus { id: string; supportedActions?: string[] }

export function InstanceMiscPanel({ instance, onSaved }: {
  instance: StrategyInstanceView
  onSaved?: (options: InstanceOptions) => void
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<InstanceOptions>(instance.options ?? {})
  const [actions, setActions] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => { setOptions(instance.options ?? {}); setDirty(false) }, [instance.id, instance.options])

  // The actions this instance can actually emit — its own executors', not
  // every executor the engine knows. Offering the rest would invite a choice
  // that can never fire.
  useEffect(() => {
    let alive = true
    void Promise.all([
      fetch('/api/strategies').then(r => (r.ok ? r.json() : []) as Promise<StrategyDefinition[]>),
      fetch('/api/executor/status').then(r => (r.ok ? r.json() : []) as Promise<ExecutorStatus[]>),
    ]).then(([defs, execs]) => {
      if (!alive) return
      const mine = new Set(defs.find(d => d.id === instance.strategyId)?.executorIds ?? [])
      const names = new Set<string>()
      for (const e of execs) {
        if (!mine.has(e.id)) continue
        for (const a of e.supportedActions ?? []) names.add(a)
      }
      setActions([...names].sort())
    }).catch(() => { if (alive) setActions([]) })
    return () => { alive = false }
  }, [instance.strategyId])

  const patch = (p: Partial<InstanceOptions>) => { setOptions(prev => ({ ...prev, ...p })); setDirty(true); setNotice('') }

  const chosen = new Set(options.alertOnActions ?? [])
  const toggleAction = (a: string) => {
    const next = new Set(chosen)
    if (!next.delete(a)) next.add(a)
    patch({ alertOnActions: [...next] })
  }

  async function save() {
    setSaving(true)
    const res = await fetch(`/api/instances/${encodeURIComponent(instance.id)}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options }),
    })
    setSaving(false)
    if (res.ok) {
      setDirty(false)
      setNotice('Saved ✓')
      onSaved?.(options)
    } else setNotice(`Save failed: ${await res.text()}`)
  }

  const alertOnFailure = options.alertOnFailure !== false
  const dryRun = options.dryRun === true

  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <button className="flex items-center gap-2 text-left flex-1 py-0.5" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>Misc</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            (alerting and dry run — applied without a restart)
          </span>
          {dryRun && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ border: '1px solid var(--warning)', color: 'var(--warning)' }}>
              DRY RUN
            </span>
          )}
          {dirty && <span className="text-xs" style={{ color: 'var(--warning)' }}>Unsaved</span>}
        </button>
        {notice && <span className="text-xs" style={{ color: notice.startsWith('Saved') ? 'var(--success)' : 'var(--danger)' }}>{notice}</span>}
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="px-3 py-1.5 rounded-md text-xs shrink-0"
          style={{ background: dirty ? 'var(--accent)' : 'var(--background)', color: dirty ? '#fff' : 'var(--muted)', border: dirty ? 'none' : '1px solid var(--border)' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={alertOnFailure} onChange={(e) => patch({ alertOnFailure: e.target.checked })} className="mt-0.5" />
            <span>
              <span className="text-sm">Alert when an execution fails</span>
              <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                On by default. Repeats of the same error are sent once every 15 minutes, and one instance may send
                at most 20 an hour — the rest are counted and reported with the next one.
              </span>
            </span>
          </label>

          <div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={chosen.size > 0}
                onChange={(e) => patch({ alertOnActions: e.target.checked ? (actions[0] ? [actions[0]] : []) : [] })}
                className="mt-0.5"
              />
              <span>
                <span className="text-sm">Alert when these actions execute</span>
                <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                  Off by default: the successful ones too, so a strategy that acts every minute would mail every minute.
                  Choose the few worth hearing about.
                </span>
              </span>
            </label>
            {chosen.size > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2 ml-7">
                {actions.length === 0 ? (
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    This strategy declares no executor, so there is no action to choose.
                  </span>
                ) : actions.map(a => (
                  <button
                    key={a}
                    onClick={() => toggleAction(a)}
                    className="text-xs px-2 py-1 rounded-md mono"
                    style={{
                      border: `1px solid ${chosen.has(a) ? 'var(--accent)' : 'var(--border)'}`,
                      color: chosen.has(a) ? 'var(--accent)' : 'var(--muted)',
                      background: 'transparent',
                    }}
                  >{a}</button>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(e) => patch({ dryRun: e.target.checked })} className="mt-0.5" />
            <span>
              <span className="text-sm">Dry run</span>
              <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                The engine records what this instance decides and queues none of it — no executor runs, nothing reaches a
                venue. Held instructions appear under Executions marked <span className="mono">dry-run</span>. This is the
                framework&apos;s own switch: it holds every instruction, including any a strategy&apos;s own dry-run
                parameter does not cover.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  )
}
