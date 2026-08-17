'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AccountSnapshotRecord } from '@openwhaleorg/core'

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
] as const

const H = 180
const PAD = { top: 12, right: 64, bottom: 22, left: 8 }

function formatUsd(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatTime(ts: number, rangeHours: number): string {
  const d = new Date(ts)
  if (rangeHours <= 48) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Single-series equity line. One series → no legend (the panel title names
 * it); 2px line in the accent hue; recessive gridlines; crosshair + tooltip
 * on hover; last value direct-labeled at the line's end.
 */
export function EquityChart({ account }: { account: string }) {
  const [hours, setHours] = useState<number>(24)
  const [series, setSeries] = useState<AccountSnapshotRecord[] | null>(null)
  const [hover, setHover] = useState<number | null>(null)   // index into series
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // viewBox width follows the CONTAINER so coordinates render 1:1 — a fixed
  // 640-wide viewBox scaled to a full-width panel stretched the whole chart
  // (fonts, strokes, spacing) ~2.6× tall.
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 120) setW(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setSeries(null)
    void fetch(`/api/accounts/${encodeURIComponent(account)}/snapshots?hours=${hours}`)
      .then(r => r.json() as Promise<AccountSnapshotRecord[]>)
      .then(data => { if (!cancelled) setSeries(data) })
      .catch(() => { if (!cancelled) setSeries([]) })
    return () => { cancelled = true }
  }, [account, hours])

  const geom = useMemo(() => {
    if (!series || series.length === 0) return null
    const t0 = series[0]!.ts
    const t1 = series[series.length - 1]!.ts
    const values = series.map(s => s.equity)
    let vMin = Math.min(...values)
    let vMax = Math.max(...values)
    if (vMin === vMax) { vMin -= 1; vMax += 1 }
    const padV = (vMax - vMin) * 0.08
    vMin -= padV; vMax += padV
    const x = (ts: number) => t1 === t0
      ? (PAD.left + (W - PAD.left - PAD.right) / 2)
      : PAD.left + ((ts - t0) / (t1 - t0)) * (W - PAD.left - PAD.right)
    const y = (v: number) => PAD.top + (1 - (v - vMin) / (vMax - vMin)) * (H - PAD.top - PAD.bottom)
    const points = series.map(s => [x(s.ts), y(s.equity)] as const)
    const path = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
    // 3 recessive horizontal gridlines with value labels
    const gridValues = [0.25, 0.5, 0.75].map(f => vMin + f * (vMax - vMin))
    return { x, y, points, path, gridValues, t0, t1 }
  }, [series, W])

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!geom || !series || series.length === 0 || !svgRef.current) return
    // 1:1 with the SVG's own units — see the width/height note on the element
    const rect = svgRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    let best = 0
    let bestDist = Infinity
    geom.points.forEach(([px], i) => {
      const d = Math.abs(px - mx)
      if (d < bestDist) { bestDist = d; best = i }
    })
    setHover(best)
  }

  const last = series?.[series.length - 1]
  const first = series?.[0]
  const changePct = last && first && first.equity !== 0
    ? ((last.equity - first.equity) / Math.abs(first.equity)) * 100
    : undefined
  const hovered = hover !== null ? series?.[hover] : undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => setHours(r.hours)}
              className="text-xs px-2 py-1 rounded-md"
              style={{
                background: hours === r.hours ? 'var(--accent)' : 'transparent',
                color: hours === r.hours ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          onClick={async () => {
            if (!confirm(`Clear ALL equity history for "${account}"? (e.g. samples taken under a wrong recipe)`)) return
            await fetch(`/api/accounts/${encodeURIComponent(account)}/snapshots`, { method: 'DELETE' })
            setSeries([])
          }}
          className="text-xs px-2 py-1 rounded-md"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
          title="Drop this account's snapshot history"
        >
          Clear history
        </button>
        {last && (
          <span className="text-sm">
            {formatUsd(last.equity)}
            {changePct !== undefined && (
              <span className="ml-2 text-xs" style={{ color: changePct >= 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
                {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}% ({RANGES.find(r => r.hours === hours)?.label})
              </span>
            )}
            {last.unrealizedPnl !== undefined && (
              <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                uPnL {formatUsd(last.unrealizedPnl)}
              </span>
            )}
          </span>
        )}
      </div>

      {series === null ? (
        <p className="text-xs py-8 text-center" style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : series.length === 0 ? (
        <p className="text-xs py-8 text-center" style={{ color: 'var(--muted)' }}>
          No snapshots yet — equity is sampled every few minutes while the runtime is up.
        </p>
      ) : (
        <div className="relative" ref={wrapRef}>
          {/* NO viewBox: width/height are the real pixel size, so one SVG unit
              is one CSS pixel and every px↔chart conversion below is identity.
              With `viewBox + w-full + a pinned height` the two aspect ratios
              disagree, and preserveAspectRatio then letterboxes the drawing —
              it renders narrower than the box and CENTRED, while the hover math
              and the tooltip both assumed it filled the box. That is what put
              the crosshair on a different point than the cursor. */}
          <svg
            ref={svgRef}
            width={W}
            height={H}
            className="block max-w-full"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* recessive grid + value labels (text tokens, never series color) */}
            {geom!.gridValues.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={geom!.y(v)} y2={geom!.y(v)} stroke="var(--border)" strokeWidth="1" />
                <text x={W - PAD.right + 6} y={geom!.y(v) + 3} fontSize="10" fill="var(--muted)">{formatUsd(v)}</text>
              </g>
            ))}
            {/* time axis: first + last */}
            <text x={PAD.left} y={H - 6} fontSize="10" fill="var(--muted)">{formatTime(geom!.t0, hours)}</text>
            <text x={W - PAD.right} y={H - 6} fontSize="10" fill="var(--muted)" textAnchor="end">{formatTime(geom!.t1, hours)}</text>

            {/* the series */}
            <path d={geom!.path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

            {/* last point, direct-labeled */}
            <circle cx={geom!.points[geom!.points.length - 1]![0]} cy={geom!.points[geom!.points.length - 1]![1]} r="3" fill="var(--accent)" />

            {/* crosshair + hovered point */}
            {hovered && hover !== null && (
              <g>
                <line
                  x1={geom!.points[hover]![0]} x2={geom!.points[hover]![0]}
                  y1={PAD.top} y2={H - PAD.bottom}
                  stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6"
                />
                <circle cx={geom!.points[hover]![0]} cy={geom!.points[hover]![1]} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
              </g>
            )}
          </svg>

          {hovered && hover !== null && (
            <div
              className="absolute pointer-events-none px-2 py-1 rounded-md text-xs whitespace-nowrap"
              style={{
                left: `${geom!.points[hover]![0]}px`,
                top: 0,
                transform: geom!.points[hover]![0] > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
              }}
            >
              <div>{formatUsd(hovered.equity)}</div>
              {hovered.unrealizedPnl !== undefined && <div style={{ color: 'var(--muted)' }}>uPnL {formatUsd(hovered.unrealizedPnl)}</div>}
              <div style={{ color: 'var(--muted)' }}>{new Date(hovered.ts).toLocaleString()}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
