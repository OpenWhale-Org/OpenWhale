'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SeriesChart, type ChartSeries, type ChartRegion, type ChartYRange } from '@/components/SeriesChart'

interface PlotInfo { id: string; title: string; kind: string; columns?: string[]; unit?: string; xKind?: 'time' | 'value'; xUnit?: string; description?: string; multi?: boolean }

interface PlotOption { value: string; label: string }

/**
 * Single-select variant picker (which capture to view) — a searchable
 * combobox instead of a native <select>: a settlement board holds hundreds
 * of captures and the only practical way to one of them is typing a few
 * letters of its label.
 */
function SingleOptionPicker({ options, value, onChange }: {
  options: PlotOption[]
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  useEffect(() => {
    if (open) searchRef.current?.focus()
    else setQuery('')
  }, [open])

  const q = query.trim().toUpperCase()
  const matches = q
    ? options.filter(o => o.label.toUpperCase().includes(q) || o.value.toUpperCase().includes(q))
    : options
  const current = options.find(o => o.value === value)

  function pick(v: string) {
    onChange(v)
    setOpen(false)
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="rounded-md px-2 py-1 text-xs font-mono max-w-64 truncate"
        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        title="Pick which capture to display"
      >
        {current?.label ?? value} ▾
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1 rounded-md shadow-lg flex flex-col"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '18rem', maxHeight: '20rem' }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); return }
              if (e.key === 'Enter' && matches.length >= 1) pick(matches[0]!.value)
            }}
            placeholder="search…"
            className="px-3 py-2 text-xs font-mono"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: 'none', borderBottom: '1px solid var(--border)', outline: 'none' }}
          />
          <div className="overflow-y-auto">
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>no match</p>
            ) : matches.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                className="w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2"
                style={{ color: 'var(--foreground)' }}
              >
                <span style={{ color: o.value === value ? 'var(--accent)' : 'var(--muted)' }}>
                  {o.value === value ? '●' : '○'}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Multi-select panel filter — which series to draw, as opposed to the
 * single-select variant picker (which capture to view).
 *
 * A checkbox dropdown rather than a native multiple <select>: the option
 * labels are long (symbol + sample count) and ⌘-clicking to keep a selection
 * is a poor fit for something toggled this often.
 */
function MultiOptionPicker({ options, selected, onChange }: {
  options: PlotOption[]
  selected: string[]
  onChange: (values: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  // Land in the search box: with hundreds of tokens the list is unusable by
  // scrolling, so typing is the primary way in.
  useEffect(() => {
    if (open) searchRef.current?.focus()
    else setQuery('')
  }, [open])

  const q = query.trim().toUpperCase()
  const matches = q
    ? options.filter(o => o.label.toUpperCase().includes(q) || o.value.toUpperCase().includes(q))
    : options

  function toggle(value: string) {
    // Never empty the selection — an empty chart reads as "broken", and the
    // server would fall back to the defaults anyway.
    const next = selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]
    if (next.length > 0) onChange(next)
  }

  /**
   * "all" adds the VISIBLE matches to the current selection rather than
   * replacing it with every option. Two reasons: with a filter typed it reads
   * as "add these", and unfiltered it would otherwise draw hundreds of series
   * — a chart nobody can read and a lot of server-side curation for it.
   */
  function selectMatches() {
    const merged = new Set(selected)
    for (const o of matches) merged.add(o.value)
    if (merged.size > 0) onChange([...merged])
  }

  function clearMatches() {
    const remaining = selected.filter(v => !matches.some(o => o.value === v))
    // Keep something drawn: fall back to the first visible match
    onChange(remaining.length > 0 ? remaining : [matches[0]?.value ?? options[0]!.value])
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="rounded-md px-2 py-1 text-xs font-mono"
        style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        title="Pick which series to draw"
      >
        {selected.length} of {options.length} ▾
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1 rounded-md shadow-lg flex flex-col"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '16rem', maxHeight: '20rem' }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); return }
              // Enter picks the single remaining match — the common case after
              // typing a few letters of a token name.
              if (e.key === 'Enter' && matches.length === 1) { toggle(matches[0]!.value); setQuery('') }
            }}
            placeholder="search…"
            className="px-3 py-2 text-xs font-mono"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: 'none', borderBottom: '1px solid var(--border)', outline: 'none' }}
          />
          <div className="flex gap-2 px-3 py-1.5 text-xs items-center" style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)' }}>
            <button type="button" onClick={selectMatches} className="hover:underline">
              {q ? `add ${matches.length}` : 'all'}
            </button>
            <button type="button" onClick={clearMatches} className="hover:underline">
              {q ? 'remove these' : 'none'}
            </button>
            <span className="ml-auto">{selected.length} selected</span>
          </div>
          <div className="overflow-y-auto">
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>no match</p>
            ) : matches.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(o.value)}
                className="w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2"
                style={{ color: 'var(--foreground)' }}
              >
                <span style={{ color: selected.includes(o.value) ? 'var(--accent)' : 'var(--muted)' }}>
                  {selected.includes(o.value) ? '☑' : '☐'}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Monitor boards — panels declared by the monitor's plots() convention. The
 * curation (extract) ran server-side in the gateway; this only picks a key,
 * fetches finished series per panel, and renders them.
 */
/**
 * Table panel: each series is a row (label = row name), cell i = points[i].y
 * under the header columns the plot declared. Built for per-token summaries
 * where a chart obscures exactly the "which token, what number" question.
 */
function PlotTable({ series, columns, unit }: { series: ChartSeries[]; columns: string[]; unit?: string }) {
  // sort: null = the plot's own order; -1 = the label column; 0.. = data column
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDesc, setSortDesc] = useState(false)
  if (series.length === 0) {
    return <div className="text-xs py-6 text-center" style={{ color: 'var(--muted)' }}>No data in window.</div>
  }
  const fmt = (v: number | undefined) => {
    if (v === undefined || !Number.isFinite(v)) return '—'
    const a = Math.abs(v)
    return a >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : a >= 10 ? v.toFixed(1) : v.toFixed(2)
  }
  const cell = (s: ChartSeries, i: number) => (s.points as Array<{ y: number }> | undefined)?.[i]?.y
  const rows = sortCol === null ? series : [...series].sort((a, b) => {
    if (sortCol === -1) {
      return sortDesc ? b.label.localeCompare(a.label) : a.label.localeCompare(b.label)
    }
    const va = cell(a, sortCol), vb = cell(b, sortCol)
    // Missing values sink to the bottom whichever direction is chosen.
    const na = va === undefined || !Number.isFinite(va), nb = vb === undefined || !Number.isFinite(vb)
    if (na && nb) return 0
    if (na) return 1
    if (nb) return -1
    return sortDesc ? vb! - va! : va! - vb!
  })
  const clickSort = (col: number) => {
    if (sortCol === col) setSortDesc(d => !d)
    else { setSortCol(col); setSortDesc(false) }
  }
  const arrow = (col: number) => sortCol === col ? (sortDesc ? ' ▾' : ' ▴') : ''
  return (
    <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 380 }}>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ color: 'var(--muted)' }}>
            <th
              className="text-left px-2 py-1 sticky top-0 cursor-pointer select-none"
              style={{ background: 'var(--background)' }}
              onClick={() => clickSort(-1)}
            >
              {unit ?? ''}{arrow(-1)}
            </th>
            {columns.map((c, i) => (
              <th
                key={c}
                className="text-right px-2 py-1 sticky top-0 cursor-pointer select-none"
                style={{ background: 'var(--background)' }}
                onClick={() => clickSort(i)}
                title="Click to sort; click again to flip the order"
              >
                {c}{arrow(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.label} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="px-2 py-1" style={{ color: 'var(--foreground)' }}>{s.label}</td>
              {columns.map((_, i) => (
                <td key={i} className="text-right px-2 py-1" style={{ color: 'var(--foreground)' }}>
                  {fmt(cell(s, i))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MonitorBoards({ monitorId, keys, emitCount, only, initialKey, bare }: {
  monitorId: string
  /** Keys with data or live subscriptions — the board's key picker. */
  keys: string[]
  /** Bumps when this monitor emits (SSE) — throttled auto-refresh hook. */
  emitCount: number
  /**
   * Render only these panel ids. For the Overview, where one widget is one
   * chart: a whole board dropped into a summary page fills the screen and
   * crowds out everything it was meant to sit beside.
   */
  only?: string[]
  /** Start on this key rather than the first with data. */
  initialKey?: string
  /** Drop the frame and the toolbar — the host card already has both. */
  bare?: boolean
}) {
  const [plots, setPlots] = useState<PlotInfo[] | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>(initialKey ?? keys[0] ?? '')
  const [series, setSeries] = useState<Record<string, ChartSeries[]>>({})
  /** Per-panel shaded x-ranges, resolved server-side over the same window as the series. */
  const [regions, setRegions] = useState<Record<string, ChartRegion[]>>({})
  /** The y mirror — cost bands, threshold zones, stop levels. */
  const [yRanges, setYRanges] = useState<Record<string, ChartYRange[]>>({})
  const [lastLoad, setLastLoad] = useState(0)
  /**
   * Expanded panels, by id. A SET rather than one id: comparing two curves
   * side by side is the normal way to read these boards, and a single-slot
   * "expanded" made every widening collapse the panel you were comparing
   * against.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** Record window per fetch. 0 = the whole stored history (the default). */
  const [window, setWindow] = useState(0)
  /** Per-panel option pickers (which capture to view / which series to draw), as returned by the gateway. */
  const [panelOptions, setPanelOptions] = useState<Record<string, { options: PlotOption[]; selected: string[] }>>({})
  /** The user's explicit picks — survive auto-refresh. Always an array; single-select panels hold one. */
  const [chosen, setChosen] = useState<Record<string, string[]>>({})

  useEffect(() => {
    let cancelled = false
    void fetch(`/api/monitor/${encodeURIComponent(monitorId)}/plots`)
      .then(r => r.json() as Promise<PlotInfo[]>)
      .then(d => { if (!cancelled) setPlots(d) })
      .catch(() => { if (!cancelled) setPlots([]) })
    return () => { cancelled = true }
  }, [monitorId])

  useEffect(() => {
    if (!keys.includes(selectedKey)) setSelectedKey((initialKey && keys.includes(initialKey) ? initialKey : keys[0]) ?? '')
  }, [keys, selectedKey])

  const load = useCallback(async () => {
    if (!plots?.length || !selectedKey) return
    setLastLoad(Date.now())
    type PanelData = { series: ChartSeries[]; options?: PlotOption[]; option?: string | string[]; regions?: ChartRegion[]; yRanges?: ChartYRange[] }
    const results = await Promise.all(plots.map(async (p): Promise<readonly [string, PanelData]> => {
      // Multi-select panels repeat the param; the server resolves whatever
      // survives against the current option list.
      const optionQs = (chosen[p.id] ?? []).map(v => `&option=${encodeURIComponent(v)}`).join('')
      const res = await fetch(`/api/monitor/${encodeURIComponent(monitorId)}/plots/${encodeURIComponent(p.id)}?key=${encodeURIComponent(selectedKey)}&n=${window}${optionQs}`)
      if (!res.ok) return [p.id, { series: [] }]
      return [p.id, await res.json() as PanelData]
    }))
    setSeries(Object.fromEntries(results.map(([id, d]) => [id, d.series])))
    // Only panels that declared shading get an entry; the rest render as before.
    setRegions(Object.fromEntries(results
      .filter(([, d]) => (d.regions?.length ?? 0) > 0)
      .map(([id, d]) => [id, d.regions!])))
    setYRanges(Object.fromEntries(results
      .filter(([, d]) => (d.yRanges?.length ?? 0) > 0)
      .map(([id, d]) => [id, d.yRanges!])))
    setPanelOptions(Object.fromEntries(results
      .filter(([, d]) => (d.options?.length ?? 0) > 0)
      .map(([id, d]) => {
        // The server echoes what it actually used — the source of truth for
        // the picker, so a stale pick resolves visibly rather than silently.
        const selected = d.option === undefined ? [] : Array.isArray(d.option) ? d.option : [d.option]
        return [id, { options: d.options!, selected }]
      })))
  }, [plots, selectedKey, monitorId, chosen, window])

  useEffect(() => { void load() }, [load])

  // Throttled auto-refresh on live emits (at most every 5s)
  useEffect(() => {
    if (emitCount === 0) return
    if (Date.now() - lastLoad < 5_000) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emitCount])

  /* `only` narrows to the named panels. Applied after the fetch rather than
     before it, so the board still knows the full panel list — a widget naming
     a panel that has since been renamed should say so, not silently show the
     rest of the board. */
  const shown = only ? (plots ?? []).filter(p => only.includes(p.id)) : plots
  if (!plots || plots.length === 0) return null
  if (only && shown!.length === 0) {
    return (
      <p className="text-xs py-6 text-center" style={{ color: 'var(--muted)' }}>
        {`This monitor no longer declares ${only.length === 1 ? 'a panel' : 'panels'} called ${only.join(', ')}.`}
      </p>
    )
  }

  const frame = bare
    ? 'flex flex-col gap-3'
    : 'rounded-lg p-4 flex flex-col gap-3'
  const frameStyle = bare ? undefined : { background: 'var(--surface)', border: '1px solid var(--border)' }

  return (
    <div className={frame} style={frameStyle}>
      <div className={bare ? 'hidden' : 'flex items-center gap-3'}>
        <h3 className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>BOARDS</h3>
        {keys.length > 0 ? (
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="rounded-md px-2 py-1 text-xs font-mono"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {keys.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        ) : (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>no keys with data yet — add a watch first</span>
        )}
        <select
          value={window}
          onChange={(e) => setWindow(Number(e.target.value))}
          className="rounded-md px-2 py-1 text-xs ml-auto"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          title="How many stored records each panel curates"
        >
          <option value={0}>all history</option>
          <option value={500}>last 500</option>
          <option value={2000}>last 2000</option>
          <option value={10000}>last 10000</option>
        </select>
        <button onClick={() => void load()} className="text-xs px-2 py-1 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>⟳</button>
      </div>

      <div
        className="grid gap-5"
        style={{ gridTemplateColumns: bare ? '1fr' : 'repeat(auto-fit, minmax(480px, 1fr))' }}
      >
        {shown!.map((p) => {
          const isExpanded = expanded.has(p.id)
          return (
            <div
              key={p.id}
              className="rounded-md p-3"
              style={{
                background: 'var(--background)',
                border: '1px solid var(--border)',
                ...(isExpanded ? { gridColumn: '1 / -1' } : {}),
              }}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {p.title}{p.unit ? <span style={{ color: 'var(--muted)' }}> ({p.unit})</span> : null}
                  </div>
                  {p.description && (
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }} title={p.description}>
                      {p.description}
                    </div>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {panelOptions[p.id] && (p.multi ? (
                    <MultiOptionPicker
                      options={panelOptions[p.id]!.options}
                      selected={chosen[p.id] ?? panelOptions[p.id]!.selected}
                      onChange={(values) => setChosen(prev => ({ ...prev, [p.id]: values }))}
                    />
                  ) : (
                    <SingleOptionPicker
                      options={panelOptions[p.id]!.options}
                      value={chosen[p.id]?.[0] ?? panelOptions[p.id]!.selected[0] ?? ''}
                      onChange={(v) => setChosen(prev => ({ ...prev, [p.id]: [v] }))}
                    />
                  ))}
                  <button
                    onClick={() => setExpanded((prev) => {
                      const next = new Set(prev)
                      if (!next.delete(p.id)) next.add(p.id)
                      return next
                    })}
                    className="text-xs px-2 py-1 rounded-md"
                    style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                    title={isExpanded ? 'Collapse' : 'Expand to full width'}
                  >
                    {isExpanded ? '⤡' : '⤢'}
                  </button>
                </div>
              </div>
              {p.kind === 'table' ? (
                <PlotTable series={series[p.id] ?? []} columns={p.columns ?? []} unit={p.unit} />
              ) : (
                <SeriesChart
                  series={series[p.id] ?? []}
                  height={isExpanded ? 380 : 230}
                  /* Monitor and panel together: the same panel of two monitors
                     is two charts, and each keeps its own marks. */
                  storageKey={`${monitorId}:${p.id}`}
                  {...(regions[p.id]?.length ? { regions: regions[p.id]! } : {})}
                  {...(yRanges[p.id]?.length ? { yRanges: yRanges[p.id]! } : {})}
                  {...(p.kind === 'scatter' ? { mode: 'scatter' as const } : {})}
                  {...(p.unit !== undefined ? { unit: p.unit } : {})}
                  {...(p.xKind !== undefined ? { xKind: p.xKind } : {})}
                  {...(p.xUnit !== undefined ? { xUnit: p.xUnit } : {})}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
