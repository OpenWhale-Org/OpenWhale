'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useColumnWidths, ResizeHandle } from './ResizableColumns'
import { useSortable } from './Sortable'
import { useT } from '@/i18n'

/**
 * A table whose columns the operator owns: drag a header to reorder, drag its
 * right edge to resize, click it to sort. Order and widths are remembered per
 * table id; sorting is handed back to the caller, because the rows on screen
 * are one page of many and only the source can order the rest.
 *
 * Reordering runs through the same `useSortable` as every other drag panel —
 * its slots are plain rectangles, so a row of headers sorts as readily as a
 * grid of cards.
 */

export interface Column<T> {
  id: string
  label: string
  /** Sort key the caller understands; omitted = not sortable. */
  sort?: string
  align?: 'left' | 'right'
  title?: string
  /** The column that absorbs leftover width; everything else is sized. */
  grow?: boolean
  width?: number
  render: (row: T) => ReactNode
}

export interface SortState { key: string; dir: 'asc' | 'desc' }

export function DataTable<T>({ tableId, columns, rows, rowKey, sort, onSort, minWidth }: {
  /** Namespaces the remembered order and widths. */
  tableId: string
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T, index: number) => string
  sort?: SortState | undefined
  onSort?: (next: SortState | undefined) => void
  minWidth?: string
}) {
  const t = useT()
  const storageKey = `ow.colorder.${tableId}`
  const [order, setOrder] = useState<string[] | null>(null)

  // Read the saved order one frame late: the server rendered the default one,
  // and reading localStorage during the first render would hydrate wrong.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      setOrder(raw ? JSON.parse(raw) as string[] : null)
    } catch { setOrder(null) }
  }, [storageKey])

  const ordered = useMemo(() => {
    if (!order) return columns
    const byId = new Map(columns.map(c => [c.id, c]))
    const out = order.map(id => byId.get(id)).filter((c): c is Column<T> => c !== undefined)
    // A column added since the order was saved still belongs on screen.
    for (const c of columns) if (!order.includes(c.id)) out.push(c)
    return out
  }, [columns, order])

  const save = useCallback((next: string[]) => {
    setOrder(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* private mode */ }
  }, [storageKey])

  const keys = ordered.map(c => c.id)
  const growKey = ordered.find(c => c.grow)?.id ?? keys[0]
  const { widthOf, startResize, reset } = useColumnWidths(tableId, keys, growKey)

  const { cardStyle, beginDrag, drag } = useSortable({
    onReorder: (next) => save(next),
    onRefile: () => {},
    onFolderMove: () => {},
  })

  const clickSort = (col: Column<T>) => {
    if (!col.sort || !onSort) return
    if (sort?.key !== col.sort) { onSort({ key: col.sort, dir: 'desc' }); return }
    onSort(sort.dir === 'desc' ? { key: col.sort, dir: 'asc' } : undefined)
  }

  return (
    <table className="w-full text-xs" style={{ tableLayout: 'fixed', ...(minWidth ? { minWidth } : {}) }}>
      <colgroup>
        {ordered.map(c => <col key={c.id} style={widthOf(c.id) !== undefined ? { width: widthOf(c.id) } : undefined} />)}
      </colgroup>
      <thead>
        <tr style={{ color: 'var(--muted)' }} data-cards="">
          {ordered.map(c => {
            const active = c.sort !== undefined && sort?.key === c.sort
            return (
              <th
                key={c.id}
                data-card-id={c.id}
                style={{ ...cardStyle(c.id), touchAction: 'none' }}
                onPointerDown={(e) => beginDrag('card', c.id, e)}
                onClick={() => clickSort(c)}
                onDoubleClick={() => reset()}
                title={c.title ?? (c.sort ? t('table.sortHint') : t('table.dragHint'))}
                className={`relative py-1 pr-3 font-medium whitespace-nowrap overflow-hidden text-ellipsis select-none ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                <span style={{ color: active ? 'var(--foreground)' : undefined, cursor: drag ? 'grabbing' : c.sort ? 'pointer' : 'grab' }}>
                  {c.label}{active && (sort!.dir === 'desc' ? ' ↓' : ' ↑')}
                </span>
                <ResizeHandle onMouseDown={(e) => startResize(c.id, e)} />
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} style={{ borderTop: '1px solid var(--border)' }}>
            {ordered.map(c => (
              <td key={c.id} className={`py-1 pr-3 whitespace-nowrap overflow-hidden text-ellipsis ${c.align === 'right' ? 'text-right' : ''}`}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
