'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ParamPreset, PresetCard, PresetSource, PresetTone } from '@openwhaleorg/core'
import { Modal } from '@/components/Modal'

/**
 * The preset picker, for presets that are more than a name.
 *
 * A list of named configurations is a dropdown and stays one. The moment a
 * strategy computes its presets live, or gives any of them a card, the list
 * is a ranking of opportunities and wants the room a dialog has: cards in a
 * grid, in the order the strategy ranked them, a refresh, and the moment the
 * numbers were taken. Choosing one fills the fields it names; every field
 * stays editable afterwards, exactly as the dropdown behaves.
 */

export function presetsNeedDialog(presets: ParamPreset[] | undefined, source: PresetSource | undefined): boolean {
  return source !== undefined || (presets ?? []).some(p => p.card !== undefined)
}

const toneColor = (tone: PresetTone | undefined): string =>
  tone === 'positive' ? 'var(--success)'
    : tone === 'negative' ? 'var(--danger)'
      : tone === 'muted' ? 'var(--muted)'
        : 'var(--foreground)'

export function PresetPickerModal({ strategyId, source, presets: staticPresets, accounts, params, current, onPick, onClose }: {
  strategyId: string
  /** Present when the strategy computes presets live; absent = the static list only. */
  source?: PresetSource | undefined
  presets: ParamPreset[]
  /** Slot label → account name, as bound in the form so far. */
  accounts: Record<string, string>
  params: { base: Record<string, unknown>; tunable: Record<string, unknown> }
  /** The preset applied last, if any — drawn as selected. */
  current?: string
  onPick: (preset: ParamPreset) => void
  onClose: () => void
}) {
  const [list, setList] = useState<ParamPreset[]>(source ? [] : staticPresets)
  const [heading, setHeading] = useState<PresetSource | undefined>(source)
  const [computedAt, setComputedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(source !== undefined)
  const [error, setError] = useState('')

  const load = useCallback(async (refresh: boolean) => {
    if (!source) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/strategies/${encodeURIComponent(strategyId)}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts, params, refresh }),
      })
      const body = (await res.json()) as { presets?: ParamPreset[]; computedAt?: number; source?: PresetSource; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setList(body.presets ?? [])
      setComputedAt(body.computedAt ?? Date.now())
      if (body.source) setHeading(body.source)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [strategyId, source, accounts, params])

  useEffect(() => { void load(false) }, [load])

  /* Cards under their group heading, groups in first-seen order; presets
     without a card are a plain list above the cards — they are the named
     configurations, and they read best as a list. */
  const plain = list.filter(p => !p.card)
  const groups: Array<{ name: string | undefined; items: ParamPreset[] }> = []
  for (const p of list) {
    if (!p.card) continue
    const name = p.card.group
    let g = groups.find(x => x.name === name)
    if (!g) { g = { name, items: [] }; groups.push(g) }
    g.items.push(p)
  }
  const cardCount = list.length - plain.length

  return (
    <Modal onClose={onClose} maxWidth="72rem" height="82vh">
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex flex-col gap-0.5 min-w-0">
            <h2 className="text-base font-semibold">{heading?.title ?? 'Presets'}</h2>
            {heading?.description && <p className="text-xs" style={{ color: 'var(--muted)' }}>{heading.description}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {computedAt !== null && !loading && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                {cardCount} · {new Date(computedAt).toLocaleTimeString()}
              </span>
            )}
            {source && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void load(true)}>
                {loading ? 'Scanning…' : 'Refresh'}
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-5">
          {error && (
            <div className="text-sm rounded-md px-3 py-2" style={{ background: 'var(--surface-inset)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
              {error}
            </div>
          )}
          {loading && list.length === 0 && !error && (
            <div className="text-sm py-10 text-center" style={{ color: 'var(--muted)' }}>Scanning the venue…</div>
          )}
          {!loading && !error && list.length === 0 && (
            <div className="text-sm py-10 text-center" style={{ color: 'var(--muted)' }}>Nothing to offer right now.</div>
          )}

          {plain.length > 0 && (
            <div className="flex flex-col gap-1">
              {plain.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPick(p)}
                  className="text-left rounded-md px-3 py-2 flex items-baseline gap-3"
                  style={{ background: 'var(--surface)', border: `1px solid ${current === p.id ? 'var(--accent)' : 'var(--border)'}` }}
                >
                  <span className="text-sm font-medium">{p.label}</span>
                  {p.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{p.description}</span>}
                </button>
              ))}
            </div>
          )}

          {groups.map((g, gi) => (
            <div key={g.name ?? `group-${gi}`} className="flex flex-col gap-2">
              {g.name && <h3 className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{g.name}</h3>}
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
                {g.items.map(p => (
                  <PresetCardView key={p.id} preset={p} card={p.card!} selected={current === p.id} onPick={() => onPick(p)} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-2 text-xs" style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
          Choosing one fills the fields it names; everything stays editable.
        </div>
      </div>
    </Modal>
  )
}

function PresetCardView({ preset, card, selected, onPick }: { preset: ParamPreset; card: PresetCard; selected: boolean; onPick: () => void }) {
  const border = `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`
  if (card.html) {
    /* A custom drawing: the frame is the card. It cannot take the click
       itself (a sandboxed frame does not bubble events out), so the wrapper
       does, and the frame is told to ignore the pointer. */
    return (
      <div role="button" tabIndex={0} onClick={onPick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onPick() }}
        className="rounded-lg overflow-hidden cursor-pointer" style={{ border, background: 'var(--surface)' }} title={preset.label}>
        <iframe sandbox="allow-scripts" scrolling="no" srcDoc={card.html} className="w-full block"
          style={{ height: card.height ?? 160, border: 0, pointerEvents: 'none', background: 'var(--surface)' }} />
      </div>
    )
  }
  return (
    <button type="button" onClick={onPick} className="text-left rounded-lg p-3 flex flex-col gap-2 transition-colors"
      style={{ background: selected ? 'var(--accent-soft)' : 'var(--surface)', border }} title={preset.description ?? preset.label}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-semibold truncate">{card.title}</span>
          {card.subtitle && <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>{card.subtitle}</span>}
        </div>
        {card.headline && (
          <div className="flex flex-col items-end shrink-0">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{card.headline.label}</span>
            <span className="text-lg font-semibold leading-tight tabular-nums" style={{ color: toneColor(card.headline.tone) }}>{card.headline.value}</span>
          </div>
        )}
      </div>
      {card.rows && card.rows.length > 0 && (
        <div className="grid gap-x-3 gap-y-0.5 text-xs" style={{ gridTemplateColumns: 'auto 1fr' }}>
          {card.rows.map((r, i) => (
            <RowPair key={i} label={r.label} value={r.value} tone={r.tone} />
          ))}
        </div>
      )}
      {card.badges && card.badges.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-auto">
          {card.badges.map((b, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ color: toneColor(b.tone ?? 'muted'), border: `1px solid ${toneColor(b.tone ?? 'muted')}`, opacity: 0.9 }}>
              {b.text}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

function RowPair({ label, value, tone }: { label: string; value: string; tone?: PresetTone | undefined }) {
  return (
    <>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="text-right tabular-nums" style={{ color: toneColor(tone) }}>{value}</span>
    </>
  )
}
