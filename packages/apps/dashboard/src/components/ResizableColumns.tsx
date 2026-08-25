'use client'

import { useEffect, useState, type ReactNode } from 'react'

/**
 * Column-width state for a fixed-layout table: drag the right edge of a
 * header to resize, widths remembered per table id in localStorage. One
 * column may be the "grow" column (no explicit width — it takes what's
 * left); every other column gets a pixel width, defaulting to `initial`.
 */
export function useColumnWidths(tableId: string, keys: string[], growKey: string | undefined, initial = 112) {
  const storageKey = `ow.cols.${tableId}`
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? JSON.parse(raw) as Record<string, number> : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(widths)) } catch { /* private mode */ }
  }, [storageKey, widths])

  const widthOf = (key: string): number | undefined => (key === growKey ? undefined : widths[key] ?? initial)

  function startResize(key: string, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widthOf(key) ?? (e.currentTarget.parentElement?.getBoundingClientRect().width ?? initial)
    const move = (ev: MouseEvent) => setWidths(prev => ({ ...prev, [key]: Math.max(48, Math.round(startW + ev.clientX - startX)) }))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const reset = () => setWidths({})
  return { widthOf, startResize, reset, keys }
}

/** The drag handle to drop at the right edge of a <th> (the th needs `position: relative`). */
export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }): ReactNode {
  return (
    <span
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      title="Drag to resize"
      className="absolute top-0 right-0 h-full cursor-col-resize select-none"
      style={{ width: 8 }}
      aria-hidden
    >
      <span className="absolute top-1 bottom-1 right-[3px] w-px" style={{ background: 'color-mix(in srgb, var(--border) 80%, transparent)' }} />
    </span>
  )
}
