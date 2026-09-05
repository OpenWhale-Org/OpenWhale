'use client'

import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '@/i18n'

/**
 * Grid-or-list, remembered per page.
 *
 * localStorage rather than the server: this is one operator's viewing
 * preference, not a property of the data. It also has to survive a reload
 * without a round trip. The initial read is deliberately lazy — reading
 * localStorage during the first render would disagree with the server's HTML
 * and hydrate wrong, so the first paint is always 'grid' and the saved choice
 * lands one frame later.
 */

export interface LayoutOption { id: string; label: string; glyph: string; hint: string }

export const LAYOUTS: readonly LayoutOption[] = [
  { id: 'grid', label: 'Grid', glyph: '▦', hint: 'Cards in a grid' },
  { id: 'list', label: 'List', glyph: '☰', hint: 'One row per item' },
]

export type LayoutId = string

/**
 * The catalogue entries for the layouts the app registers. LAYOUTS above is a
 * module-level constant that pages extend before any hook can run, so the
 * option carries its English and the switch looks the id up at render time;
 * an id not listed here shows the option's own label and hint.
 */
const LAYOUT_TEXT: Record<string, { label: MessageKey; hint: MessageKey }> = {
  grid: { label: 'ui.layout.grid', hint: 'ui.layout.gridHint' },
  list: { label: 'ui.layout.list', hint: 'ui.layout.listHint' },
  whale: { label: 'ui.layout.whale', hint: 'ui.layout.whaleHint' },
}

/**
 * `key` namespaces the preference per page, e.g. 'ow:instances-layout'.
 * `options` lets a page add its own — the strategies page has a third.
 */
export function useLayout(key: string, options: readonly LayoutOption[] = LAYOUTS): [LayoutId, (id: LayoutId) => void] {
  const [layout, setLayout] = useState<LayoutId>(options[0]?.id ?? 'grid')
  useEffect(() => {
    const saved = window.localStorage.getItem(key)
    if (options.some(l => l.id === saved)) setLayout(saved!)
    // `options` is a module-level constant at every call site; listing it would
    // only re-run this on identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const choose = (id: LayoutId) => {
    setLayout(id)
    try { window.localStorage.setItem(key, id) } catch { /* private mode — the choice just will not stick */ }
  }
  return [layout, choose]
}

/** Segmented control: one button per registered layout. */
export function LayoutSwitch({ value, onChange, options = LAYOUTS }: {
  value: LayoutId
  onChange: (id: LayoutId) => void
  options?: readonly LayoutOption[]
}) {
  const t = useT()
  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {options.map(l => (
        <button
          key={l.id}
          onClick={() => onChange(l.id)}
          title={LAYOUT_TEXT[l.id] ? t(LAYOUT_TEXT[l.id]!.hint) : l.hint}
          aria-pressed={value === l.id}
          className="px-2 py-1 text-xs flex items-center gap-1.5"
          style={{
            background: value === l.id ? 'var(--accent)' : 'transparent',
            color: value === l.id ? '#fff' : 'var(--muted)',
          }}
        >
          <span aria-hidden>{l.glyph}</span>
          {LAYOUT_TEXT[l.id] ? t(LAYOUT_TEXT[l.id]!.label) : l.label}
        </button>
      ))}
    </div>
  )
}
