'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useColumnWidths, ResizeHandle } from './ResizableColumns'
import { useSortable } from './Sortable'
import { useAnchoredPlacement } from './popover'
import { useT } from '@/i18n'

/**
 * A table whose columns the operator owns: drag a header to reorder, drag its
 * right edge to resize, click it to sort, and hide the ones this operator
 * never reads. Order, widths and what is hidden are remembered per table id;
 * sorting is handed back to the caller, because the rows on screen are one
 * page of many and only the source can order the rest.
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
  /** Namespaces the remembered order, widths and hidden set. */
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
  const hiddenKey = `ow.colhidden.${tableId}`
  const [order, setOrder] = useState<string[] | null>(null)
  const [hidden, setHidden] = useState<string[]>([])

  // Read the saved layout one frame late: the server rendered the default
  // one, and reading localStorage during the first render would hydrate wrong.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      setOrder(raw ? JSON.parse(raw) as string[] : null)
    } catch { setOrder(null) }
    try {
      const raw = localStorage.getItem(hiddenKey)
      setHidden(raw ? JSON.parse(raw) as string[] : [])
    } catch { setHidden([]) }
  }, [storageKey, hiddenKey])

  const arranged = useMemo(() => {
    if (!order) return columns
    const byId = new Map(columns.map(c => [c.id, c]))
    const out = order.map(id => byId.get(id)).filter((c): c is Column<T> => c !== undefined)
    // A column added since the order was saved still belongs on screen.
    for (const c of columns) if (!order.includes(c.id)) out.push(c)
    return out
  }, [columns, order])
  const ordered = useMemo(() => arranged.filter(c => !hidden.includes(c.id)), [arranged, hidden])

  const save = useCallback((next: string[]) => {
    setOrder(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* private mode */ }
  }, [storageKey])

  const setHiddenSaved = useCallback((next: string[]) => {
    setHidden(next)
    try { localStorage.setItem(hiddenKey, JSON.stringify(next)) } catch { /* private mode */ }
  }, [hiddenKey])

  const keys = ordered.map(c => c.id)
  const growKey = ordered.find(c => c.grow)?.id ?? keys[0]
  const { widthOf, startResize, reset } = useColumnWidths(tableId, keys, growKey)

  const { cardStyle, beginDrag, drag } = useSortable({
    // The dragged order covers the VISIBLE columns; the hidden ones keep the
    // places they had, so unhiding one does not send it to the end.
    onReorder: (next) => save(mergeHidden(arranged.map(c => c.id), next)),
    onRefile: () => {},
    onFolderMove: () => {},
  })

  const clickSort = (col: Column<T>) => {
    if (!col.sort || !onSort) return
    if (sort?.key !== col.sort) { onSort({ key: col.sort, dir: 'desc' }); return }
    onSort(sort.dir === 'desc' ? { key: col.sort, dir: 'asc' } : undefined)
  }

  return (
    <>
      <div className="flex justify-end pb-1">
        <ColumnMenu
          columns={arranged.map(c => ({ id: c.id, label: c.label }))}
          hidden={hidden}
          onToggle={(id) => setHiddenSaved(hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id])}
          onShowAll={() => setHiddenSaved([])}
          onResetLayout={() => { reset(); save(columns.map(c => c.id)); setHiddenSaved([]) }}
        />
      </div>
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
    </>
  )
}

/**
 * Re-thread a reordered list of visible ids through the full one, leaving the
 * hidden columns where they sit. Without it, hiding a column and dragging
 * another would quietly move the hidden one to the end of the table.
 */
function mergeHidden(all: string[], visible: string[]): string[] {
  const moving = new Set(visible)
  const queue = [...visible]
  return all.map(id => (moving.has(id) ? queue.shift()! : id))
}

/** Which columns this operator wants to see. */
function ColumnMenu({ columns, hidden, onToggle, onShowAll, onResetLayout }: {
  columns: Array<{ id: string; label: string }>
  hidden: string[]
  onToggle: (id: string) => void
  onShowAll: () => void
  onResetLayout: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const place = useAnchoredPlacement(open, anchor, { maxHeight: 360, minWidth: 220 })

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!anchor.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // A frame late, or the click that opened the menu closes it again.
    const timer = setTimeout(() => document.addEventListener('mousedown', close), 0)
    document.addEventListener('keydown', esc)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen(v => !v)}
        className="text-xs px-2 py-1 rounded-md"
        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
        title={t('table.columnsHint')}
      >
        {hidden.length > 0 ? t('table.columnsN', { n: columns.length - hidden.length, total: columns.length }) : t('table.columns')}
      </button>
      {open && place && createPortal(
        <div
          className="rounded-md overflow-auto scroll-hidden text-xs py-1"
          style={{
            position: 'fixed', left: place.left, width: place.width, maxHeight: place.maxHeight,
            ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
            background: 'var(--surface)', border: '1px solid var(--border)', zIndex: 80,
            boxShadow: '0 12px 32px rgba(0,0,0,.45)',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {columns.map(c => (
            <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hoverable">
              <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => onToggle(c.id)} />
              <span>{c.label}</span>
            </label>
          ))}
          <div className="flex gap-2 px-3 pt-1.5 mt-1" style={{ borderTop: '1px solid var(--border)' }}>
            <button type="button" className="text-xs py-1" style={{ color: 'var(--accent)' }} onClick={onShowAll}>{t('table.showAll')}</button>
            <span className="flex-1" />
            <button type="button" className="text-xs py-1" style={{ color: 'var(--muted)' }} onClick={onResetLayout}>{t('table.resetLayout')}</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
