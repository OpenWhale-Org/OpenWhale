'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Rail, RailGroup, RailItem } from '../../components/Rail'
import type { StrategyDefinition } from '@openwhaleorg/core'
import { ModalMaximizeButton } from '@/components/Modal'

/**
 * Choosing a strategy used to be a bare `<select>` of registry ids — you had
 * to already know what `pair-arb/rtz-reversion` does to pick it. This is the
 * same choice with the evidence attached: browse by plugin on the left, read
 * what the strategy needs and what it exposes on the right, commit once.
 */

const SOURCE_LABEL: Record<string, string> = {
  builtin: 'Built-in',
  plugin: 'Plugin',
  compiled: 'AI-compiled',
}

/** Group heading for a strategy: its plugin, or where else it came from. */
function groupOf(s: StrategyDefinition): string {
  if (s.pluginName) return s.pluginName
  return SOURCE_LABEL[s.source] ?? s.source
}

function matches(s: StrategyDefinition, q: string): boolean {
  if (!q) return true
  const hay = [s.name, s.id, s.description ?? '', s.pluginName ?? '', ...(s.monitorIds ?? [])]
    .join(' ').toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(term => hay.includes(term))
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>{title}</div>
      {children}
    </div>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <div className="text-xs" style={{ color: 'var(--muted)' }}>{empty}</div>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(v => <span key={v} className="badge badge-neutral mono">{v}</span>)}
    </div>
  )
}

export function StrategyBrowser({ strategies, selectedId, onPick, onCancel, cancelLabel = 'Cancel' }: {
  strategies: StrategyDefinition[]
  /** Current choice, so reopening lands on it instead of the top of the list. */
  selectedId?: string
  onPick: (id: string) => void
  onCancel: () => void
  cancelLabel?: string
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>(selectedId ?? '')
  const searchRef = useRef<HTMLInputElement>(null)

  const groups = useMemo(() => {
    const hits = strategies.filter(s => matches(s, query))
    const byGroup = new Map<string, StrategyDefinition[]>()
    for (const s of hits) {
      const g = groupOf(s)
      ;(byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(s)
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => ({ name, items: items.sort((x, y) => x.name.localeCompare(y.name)) }))
  }, [strategies, query])

  const flat = useMemo(() => groups.flatMap(g => g.items), [groups])
  const current = strategies.find(s => s.id === selected)

  // Keep a selection alive as the filter narrows, so the right pane never
  // blanks out mid-search.
  useEffect(() => {
    if (flat.length === 0) return
    if (!flat.some(s => s.id === selected)) setSelected(flat[0]!.id)
  }, [flat, selected])

  useEffect(() => { searchRef.current?.focus() }, [])

  // Esc belongs to the hosting Modal — handling it here too would collapse a
  // wizard's step and the wizard itself in one press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && current) { onPick(current.id); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const i = flat.findIndex(s => s.id === selected)
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1
      if (next >= 0 && next < flat.length) setSelected(flat[next]!.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flat, selected, current, onPick, onCancel])

  const params = current?.paramsFields ?? []
  const required = params.filter(f => f.required)
  const tunable = params.filter(f => !f.required)

  return (
    <>
      <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div>
          <div className="text-sm font-medium">Choose a strategy</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            Step 1 of 2 · {strategies.length} available · ↑↓ to move, Enter to select
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">{cancelLabel}</button>
          <ModalMaximizeButton />
        </div>
      </div>

      <div data-tour="strategy-picker" className="flex flex-1 min-h-0">
          {/* ── Left: search + grouped list ── */}
          <Rail bare width="16rem" search={{ value: query, onChange: setQuery, placeholder: 'Search strategies…', autoFocus: true }}>
            {groups.length === 0 && (
              <div className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>Nothing matches “{query}”.</div>
            )}
            {groups.map(g => (
              <RailGroup key={g.name} label={g.name} count={g.items.length}>
                {g.items.map(s => (
                  <RailItem
                    key={s.id}
                    active={s.id === selected}
                    onClick={() => setSelected(s.id)}
                    onDoubleClick={() => onPick(s.id)}
                    title={s.name || s.id}
                    subtitle={s.name ? s.id : undefined}
                  />
                ))}
              </RailGroup>
            ))}
          </Rail>

          {/* ── Right: what this strategy is and what it will ask for ── */}
          <div className="flex-1 min-w-0 flex flex-col">
            {!current ? (
              <div className="flex-1 grid place-items-center text-sm" style={{ color: 'var(--muted)' }}>
                No strategy selected
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold">{current.name || current.id}</h3>
                      <span className="badge badge-neutral">{SOURCE_LABEL[current.source] ?? current.source}</span>
                    </div>
                    <div className="text-xs mono mt-1" style={{ color: 'var(--muted)' }}>{current.id}</div>
                    {current.description && (
                      <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--foreground-soft)' }}>
                        {current.description}
                      </p>
                    )}
                  </div>

                  <Section title="Accounts it binds">
                    {(current.accountRequirements ?? []).length === 0
                      ? <div className="text-xs" style={{ color: 'var(--muted)' }}>None — this strategy trades through no account of its own.</div>
                      : (
                        <div className="flex flex-wrap gap-1.5">
                          {current.accountRequirements!.map(a => (
                            <span key={a.label} className="badge badge-neutral">
                              <span className="mono">{a.label}</span>
                              <span style={{ color: 'var(--muted)' }}>{a.type ?? a.kind}</span>
                              {a.optional && <span style={{ color: 'var(--muted)' }}>· optional</span>}
                            </span>
                          ))}
                        </div>
                      )}
                  </Section>

                  <div className="grid grid-cols-2 gap-4">
                    <Section title="Monitors it reads">
                      <Chips items={current.monitorIds ?? []} empty="None" />
                    </Section>
                    <Section title="Executors it drives">
                      <Chips items={current.executorIds ?? []} empty="None" />
                    </Section>
                  </div>

                  {(current.llmRequirements ?? []).length > 0 && (
                    <Section title="LLM slots">
                      <Chips items={current.llmRequirements!.map(l => `${l.label} · ${l.model}`)} empty="None" />
                    </Section>
                  )}

                  <Section title={`Parameters — ${required.length} required, ${tunable.length} tunable`}>
                    {params.length === 0 ? (
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>
                        No declared fields; this strategy takes raw JSON params.
                      </div>
                    ) : (
                      <div className="card-inset divide-y" style={{ borderColor: 'var(--border)' }}>
                        {[...required, ...tunable].slice(0, 40).map(f => (
                          <div key={f.name} className="px-3 py-2 flex items-baseline gap-3" style={{ borderColor: 'var(--border)' }}>
                            <div className="text-xs shrink-0 w-44 truncate" title={f.displayName ?? f.name}>
                              {f.displayName ?? f.name}
                              {f.required && <span style={{ color: 'var(--warning)' }}> *</span>}
                            </div>
                            <div className="text-xs min-w-0 flex-1" style={{ color: 'var(--muted)' }}>
                              {f.description
                                ? <span className="line-clamp-2">{f.description}</span>
                                : <span className="mono">{f.type}</span>}
                            </div>
                          </div>
                        ))}
                        {params.length > 40 && (
                          <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                            … and {params.length - 40} more, all editable after you create the instance.
                          </div>
                        )}
                      </div>
                    )}
                  </Section>
                </div>

                <div className="flex justify-end gap-2 px-5 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
                  <button type="button" onClick={onCancel} className="btn btn-secondary">{cancelLabel}</button>
                  <button type="button" onClick={() => onPick(current.id)} className="btn btn-primary">
                    Use this strategy →
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
    </>
  )
}
