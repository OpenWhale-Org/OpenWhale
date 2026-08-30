'use client'

import { useEffect, useMemo, useState } from 'react'
import type { StrategyInstanceView } from '@openwhaleorg/core'
import { Modal } from '@/components/Modal'
import { Select } from '@/components/Select'
import { KINDS, newWidgetId, type Widget, type WidgetKind } from './widgets'

/**
 * Choosing what to add.
 *
 * The built-ins are a plain list — one of each, so the ones already on the
 * page are shown taken rather than hidden: an operator looking for "Total
 * equity" should find it and learn it is already there, not fail to find it
 * and conclude the dashboard cannot do it.
 *
 * The two configurable kinds need a target, so each carries its own small
 * form. A monitor panel is three choices (monitor, panel, key) and the second
 * two depend on the first, which is why they are revealed in order rather than
 * offered as three dropdowns of everything.
 */

interface MonitorStatus { id: string; name: string; activeKeys?: Array<{ key: string }>; manualKeys?: string[]; dataKeys?: string[] }
interface PlotInfo { id: string; title?: string; kind: string }

export function WidgetPicker({ present, instances, onAdd, onClose }: {
  present: WidgetKind[]
  instances: StrategyInstanceView[]
  onAdd: (w: Widget) => void
  onClose: () => void
}) {
  const [monitors, setMonitors] = useState<MonitorStatus[]>([])
  const [monitorId, setMonitorId] = useState('')
  const [plots, setPlots] = useState<PlotInfo[]>([])
  const [panelId, setPanelId] = useState('')
  const [dataKey, setDataKey] = useState('')
  const [instanceId, setInstanceId] = useState('')

  useEffect(() => {
    void fetch('/api/monitor/status')
      .then(r => (r.ok ? r.json() : []) as Promise<MonitorStatus[]>)
      .then(setMonitors)
      .catch(() => setMonitors([]))
  }, [])

  // Panels belong to a monitor, so they are fetched when one is chosen and
  // cleared when it changes — a stale panel list is a way to build a widget
  // that points at nothing.
  useEffect(() => {
    setPanelId('')
    setDataKey('')
    if (!monitorId) { setPlots([]); return }
    void fetch(`/api/monitor/${encodeURIComponent(monitorId)}/plots`)
      .then(r => (r.ok ? r.json() : []) as Promise<PlotInfo[]>)
      .then(setPlots)
      .catch(() => setPlots([]))
  }, [monitorId])

  const keys = useMemo(() => {
    const m = monitors.find(x => x.id === monitorId)
    if (!m) return []
    return [...new Set([...(m.activeKeys ?? []).map(k => k.key), ...(m.manualKeys ?? []), ...(m.dataKeys ?? [])])]
  }, [monitors, monitorId])

  const taken = new Set(present)
  const builtIns = (Object.keys(KINDS) as WidgetKind[]).filter(k => KINDS[k].singleton)

  const add = (w: Widget) => { onAdd(w); onClose() }

  return (
    <Modal onClose={onClose} maxWidth="42rem">
      <div className="px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="text-sm font-medium">Add a widget</div>
      </div>

      <div className="p-5 flex flex-col gap-5 overflow-y-auto scroll-hidden">
        {/* ── A monitor panel ────────────────────────────────────────────── */}
        <section>
          <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>MONITOR PANEL</h3>
          <div className="flex flex-col gap-2">
            <Select
              value={monitorId}
              onChange={setMonitorId}
              placeholder="Choose a monitor…"
              options={monitors.map(m => ({ value: m.id, label: m.name, hint: m.id }))}
            />
            {monitorId && (
              <Select
                value={panelId}
                onChange={setPanelId}
                placeholder={plots.length === 0 ? 'This monitor declares no panels' : 'Choose a panel…'}
                options={plots.map(p => ({ value: p.id, label: p.title ?? p.id, hint: p.kind }))}
              />
            )}
            {monitorId && panelId && (
              <>
                <Select
                  value={dataKey}
                  onChange={setDataKey}
                  placeholder={keys.length === 0 ? 'No keys with data yet' : 'Choose a key…'}
                  options={keys.map(k => ({ value: k, label: k }))}
                />
                <button
                  className="btn btn-primary self-start"
                  disabled={!dataKey}
                  onClick={() => add({
                    id: newWidgetId(), kind: 'monitor-panel', monitorId, panelId,
                    dataKey, title: `${monitors.find(m => m.id === monitorId)?.name ?? monitorId} · ${plots.find(p => p.id === panelId)?.title ?? panelId}`,
                  })}
                >Add panel</button>
              </>
            )}
          </div>
        </section>

        {/* ── A strategy ─────────────────────────────────────────────────── */}
        <section>
          <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>STRATEGY</h3>
          {instances.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>No instances configured yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <Select
                value={instanceId}
                onChange={setInstanceId}
                placeholder="Choose an instance…"
                options={instances.map(i => ({ value: i.id, label: i.name, hint: i.strategyId }))}
              />
              <button
                className="btn btn-primary self-start"
                disabled={!instanceId}
                onClick={() => add({ id: newWidgetId(), kind: 'instance', instanceId })}
              >Add strategy</button>
            </div>
          )}
        </section>

        {/* ── The built-ins ──────────────────────────────────────────────── */}
        <section>
          <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>BUILT IN</h3>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))' }}>
            {builtIns.map((kind) => {
              const on = taken.has(kind)
              return (
                <button
                  key={kind}
                  disabled={on}
                  onClick={() => add({ id: newWidgetId(), kind } as Widget)}
                  className="text-left rounded-md px-3 py-2"
                  style={{
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    opacity: on ? 0.5 : 1,
                    cursor: on ? 'default' : 'pointer',
                  }}
                >
                  <span className="text-sm block">
                    {KINDS[kind].label}
                    {on && <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}>on the page</span>}
                  </span>
                  <span className="text-xs block" style={{ color: 'var(--muted)' }}>{KINDS[kind].description}</span>
                </button>
              )
            })}
          </div>
        </section>
      </div>

      <div className="px-5 py-3 flex justify-end shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
        <button onClick={onClose} className="btn btn-secondary btn-sm">Close</button>
      </div>
    </Modal>
  )
}
