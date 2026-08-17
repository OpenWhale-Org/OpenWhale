'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CombinedAccountEquityPoint, CombinedAccountEquitySeries } from '@openwhaleorg/core'

const RANGES = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
] as const

const HEIGHT = 210
const PAD = { top: 16, right: 68, bottom: 28, left: 10 }

export type PortfolioRange = typeof RANGES[number]['value']

export interface PortfolioEquityResponse extends CombinedAccountEquitySeries {
  range: PortfolioRange
  sampledAt: number
}

export interface PortfolioEquityState {
  data: PortfolioEquityResponse | null
  error: string | null
  loading: boolean
  range: PortfolioRange
  refresh: () => void
  setRange: (range: PortfolioRange) => void
}

function formatUsd(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function formatAxisTime(ts: number, range: PortfolioRange): string {
  const date = new Date(ts)
  if (range === '24h') return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1_000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

export function usePortfolioEquity(): PortfolioEquityState {
  const [range, setRange] = useState<PortfolioRange>('7d')
  const [data, setData] = useState<PortfolioEquityResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false

    const load = async () => {
      try {
        const response = await fetch(`/api/portfolio/equity-series?range=${range}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = await response.json() as PortfolioEquityResponse
        if (!disposed) {
          setData(next)
          setError(null)
        }
      } catch (cause) {
        if (!disposed && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Unable to load portfolio history')
        }
      } finally {
        if (!disposed) setLoading(false)
      }
    }

    setLoading(true)
    setData(null)
    void load()
    const refreshTimer = window.setInterval(() => void load(), 60_000)
    return () => {
      disposed = true
      controller.abort()
      window.clearInterval(refreshTimer)
    }
  }, [range, requestVersion])

  return {
    data,
    error,
    loading,
    range,
    refresh: () => setRequestVersion(version => version + 1),
    setRange,
  }
}

export function PortfolioEquitySparkline({ points }: { points: CombinedAccountEquityPoint[] }) {
  const completePoints = points.filter(point => point.accountCount === point.expectedAccountCount)
  if (completePoints.length < 2) return <span className="aurora-sparkline-empty">No history</span>
  const values = completePoints.slice(-20).map(point => point.equity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1, max - min)
  const polyline = values.map((value, index) => (
    `${(index / (values.length - 1)) * 100},${38 - ((value - min) / span) * 32}`
  )).join(' ')
  const positive = values[values.length - 1]! >= values[0]!

  return (
    <svg className="aurora-sparkline" viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={polyline}
        fill="none"
        stroke={positive ? 'var(--accent)' : 'var(--danger)'}
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function PortfolioEquityChart({ state }: { state: PortfolioEquityState }) {
  const { data, error, loading, range, refresh, setRange } = state
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width
      if (nextWidth && nextWidth > 160) setWidth(Math.round(nextWidth))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => setHover(null), [range])

  const geometry = useMemo(() => {
    if (!data || data.points.length === 0) return null
    const values = data.points.map(point => point.equity)
    let valueMin = Math.min(...values)
    let valueMax = Math.max(...values)
    if (valueMin === valueMax) {
      const flatPadding = Math.max(1, Math.abs(valueMin) * 0.002)
      valueMin -= flatPadding
      valueMax += flatPadding
    } else {
      const valuePadding = (valueMax - valueMin) * 0.1
      valueMin -= valuePadding
      valueMax += valuePadding
    }

    const x = (ts: number) => PAD.left + ((ts - data.from) / Math.max(1, data.to - data.from)) * (width - PAD.left - PAD.right)
    const y = (value: number) => PAD.top + (1 - (value - valueMin) / (valueMax - valueMin)) * (HEIGHT - PAD.top - PAD.bottom)
    const coordinates = data.points.map(point => ({ x: x(point.ts), y: y(point.equity), point }))
    const groups: Array<{ coordinates: typeof coordinates; partial: boolean }> = []
    let group: typeof coordinates = []
    for (const coordinate of coordinates) {
      const previous = group[group.length - 1]
      const partial = coordinate.point.accountCount < coordinate.point.expectedAccountCount
      const previousPartial = previous
        ? previous.point.accountCount < previous.point.expectedAccountCount
        : partial
      if (previous && (coordinate.point.ts - previous.point.ts > data.bucketMs * 2.5 || partial !== previousPartial)) {
        groups.push({ coordinates: group, partial: previousPartial })
        group = []
      }
      group.push(coordinate)
    }
    if (group.length > 0) {
      const last = group[group.length - 1]!
      groups.push({
        coordinates: group,
        partial: last.point.accountCount < last.point.expectedAccountCount,
      })
    }

    const gridValues = [0, 1 / 3, 2 / 3, 1].map(fraction => valueMin + fraction * (valueMax - valueMin))
    const timeTicks = [0, 0.25, 0.5, 0.75, 1].map(fraction => data.from + fraction * (data.to - data.from))
    return { coordinates, gridValues, groups, timeTicks, x, y }
  }, [data, width])

  const completePoints = data?.points.filter(point => point.accountCount === point.expectedAccountCount) ?? []
  const first = completePoints[0]
  const latest = completePoints[completePoints.length - 1]
  const latestSample = data?.points[data.points.length - 1]
  const change = first && latest ? latest.equity - first.equity : null
  const changePct = first && change !== null && first.equity !== 0 ? change / Math.abs(first.equity) * 100 : null
  const partial = Boolean(latestSample && latestSample.accountCount < latestSample.expectedAccountCount)
  const stale = Boolean(latest && data && Date.now() - latest.ts > Math.max(10 * 60_000, data.bucketMs * 2.5))
  const hovered = hover !== null ? geometry?.coordinates[hover] : undefined

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!geometry || !svgRef.current) return
    const bounds = svgRef.current.getBoundingClientRect()
    const pointerX = ((event.clientX - bounds.left) / bounds.width) * width
    let nearest = 0
    let distance = Number.POSITIVE_INFINITY
    geometry.coordinates.forEach((coordinate, index) => {
      const nextDistance = Math.abs(coordinate.x - pointerX)
      if (nextDistance < distance) {
        distance = nextDistance
        nearest = index
      }
    })
    setHover(nearest)
  }

  return (
    <article className="aurora-dashboard-card aurora-performance-card">
      <div className="aurora-card-header aurora-portfolio-header">
        <div>
          <h2>Portfolio Equity</h2>
          <p>
            {latest ? `${formatUsd(latest.equity)} · ${change !== null && change >= 0 ? '+' : ''}${change !== null ? formatUsd(change) : '—'}${changePct !== null ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)` : ''}` : 'Combined account equity'}
          </p>
        </div>
        <div className="aurora-time-tabs" aria-label="Portfolio equity range">
          {RANGES.map(option => (
            <button
              key={option.value}
              type="button"
              className={range === option.value ? 'active' : ''}
              onClick={() => setRange(option.value)}
              aria-pressed={range === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="aurora-equity-chart aurora-real-equity-chart" ref={wrapRef}>
        {loading ? (
          <div className="aurora-chart-message"><span className="aurora-chart-loader" /> Loading equity history…</div>
        ) : error ? (
          <div className="aurora-chart-message is-error">
            <span>Portfolio history is temporarily unavailable.</span>
            <button type="button" onClick={refresh}>Retry</button>
          </div>
        ) : !data || data.expectedAccounts.length === 0 ? (
          <div className="aurora-chart-message">Connect a ready account to start recording portfolio equity.</div>
        ) : data.points.length === 0 ? (
          <div className="aurora-chart-message">No equity history yet. The first samples are collected while the runtime is online.</div>
        ) : geometry && latestSample ? (
          <>
            <div className="aurora-chart-freshness">
              <span className={stale ? 'is-stale' : ''}>{latest ? `${stale ? 'Stale' : 'Updated'} ${relativeTime(latest.ts)}` : 'No complete samples'}</span>
              <span className={partial ? 'is-partial' : ''}>{latestSample.accountCount}/{latestSample.expectedAccountCount} accounts</span>
            </div>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${width} ${HEIGHT}`}
              preserveAspectRatio="none"
              onPointerMove={onPointerMove}
              onPointerLeave={() => setHover(null)}
              aria-label={`Portfolio equity for the last ${range}`}
              role="img"
            >
              <defs>
                <linearGradient id="real-overview-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop stopColor="#8267f5" stopOpacity=".28" />
                  <stop offset="1" stopColor="#8267f5" stopOpacity="0" />
                </linearGradient>
              </defs>

              {geometry.gridValues.map(value => (
                <g key={value}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={geometry.y(value)} y2={geometry.y(value)} className="aurora-chart-gridline" />
                  <text x={width - PAD.right + 8} y={geometry.y(value) + 3} className="aurora-chart-label">{formatUsd(value)}</text>
                </g>
              ))}

              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={geometry.y((first ?? latestSample).equity)}
                y2={geometry.y((first ?? latestSample).equity)}
                className="aurora-chart-baseline"
              />

              {geometry.groups.map(({ coordinates, partial: partialGroup }, index) => {
                const line = coordinates.map((coordinate, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${coordinate.x.toFixed(1)},${coordinate.y.toFixed(1)}`).join(' ')
                const area = coordinates.length > 1 && !partialGroup
                  ? `${line} L${coordinates[coordinates.length - 1]!.x.toFixed(1)},${HEIGHT - PAD.bottom} L${coordinates[0]!.x.toFixed(1)},${HEIGHT - PAD.bottom} Z`
                  : ''
                return (
                  <g key={index}>
                    {area && <path d={area} fill="url(#real-overview-fill)" />}
                    <path d={line} className={`aurora-chart-equity-line${partialGroup ? ' is-partial' : ''}`} />
                    {partialGroup && coordinates.map(coordinate => (
                      <circle key={coordinate.point.ts} cx={coordinate.x} cy={coordinate.y} r="2.5" className="aurora-chart-partial-point" />
                    ))}
                  </g>
                )
              })}

              {geometry.timeTicks.map((ts, index) => (
                <text
                  key={ts}
                  x={geometry.x(ts)}
                  y={HEIGHT - 6}
                  textAnchor={index === 0 ? 'start' : index === geometry.timeTicks.length - 1 ? 'end' : 'middle'}
                  className="aurora-chart-label"
                >
                  {formatAxisTime(ts, range)}
                </text>
              ))}

              {hovered && (
                <g>
                  <line x1={hovered.x} x2={hovered.x} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="aurora-chart-crosshair" />
                  <circle cx={hovered.x} cy={hovered.y} r="4" className="aurora-chart-hover-point" />
                </g>
              )}
              <circle
                cx={geometry.coordinates[geometry.coordinates.length - 1]!.x}
                cy={geometry.coordinates[geometry.coordinates.length - 1]!.y}
                r="3.5"
                className={`aurora-chart-last-point${partial ? ' is-partial' : ''}`}
              />
            </svg>

            {hovered && (
              <div
                className="aurora-equity-tooltip"
                style={{
                  left: `${(hovered.x / width) * 100}%`,
                  top: `${Math.max(8, hovered.y - 60)}px`,
                  transform: hovered.x > width * 0.72 ? 'translateX(-105%)' : 'translateX(10px)',
                }}
              >
                <strong>{formatUsd(hovered.point.equity)}</strong>
                {hovered.point.unrealizedPnl !== undefined && <span>uPnL {formatUsd(hovered.point.unrealizedPnl)}</span>}
                {hovered.point.available !== undefined && <span>Available {formatUsd(hovered.point.available)}</span>}
                <span>{hovered.point.accountCount}/{hovered.point.expectedAccountCount} accounts</span>
                {hovered.point.missingAccounts.length > 0 && <span className="is-warning">Missing: {hovered.point.missingAccounts.join(', ')}</span>}
                <time>{new Date(hovered.point.ts).toLocaleString()}</time>
              </div>
            )}
          </>
        ) : null}
      </div>
    </article>
  )
}
