'use client'

import { useRef, useState } from 'react'

/**
 * Pointer-based reordering for card grids — the shared implementation.
 *
 * Every drag-to-reorder panel in the dashboard uses this. Two approaches were
 * tried and abandoned first, and both failed the same way, so the design notes
 * below are the point of the file rather than decoration.
 *
 * NOT the native HTML5 drag-and-drop API: it paints a translucent CLONE and
 * gives no control over it, so what follows the cursor is a picture while the
 * card you grabbed sits untouched. Here the real element moves.
 *
 * NOT reorder-the-DOM-then-animate-with-FLIP either. That shape is a feedback
 * loop by construction:
 *
 *     drag → reorder DOM → ask the DOM what is under the cursor
 *              ↑_______________________________|
 *
 * The reorder pushes a neighbour under the cursor, the target flips, the
 * neighbour slides back, forever. No amount of hysteresis fixes a loop whose
 * input is its own output.
 *
 * What this does instead:
 *
 *   1. Measure every slot ONCE at pointer-down and never re-read the DOM.
 *      Pointer position → target index becomes a pure function of numbers
 *      taken before anything moved, so the preview cannot feed back into it.
 *   2. Move nothing in the DOM. Each card is placed by `transform`, which CSS
 *      animates on its own — no FLIP, no reflow, nothing for React's
 *      re-render to fight over.
 *   3. Leave the dragged card in the flow, so its slot stays open instead of
 *      collapsing the grid (and nothing needs `position: fixed`, which once
 *      made a card 100vh tall because its containing block became the
 *      viewport).
 */

/** One card's measured footprint, taken at pointer-down and never re-read. */
interface Slot { id: string; left: number; top: number; w: number; h: number }

export interface DragState {
  kind: 'card' | 'folder'
  id: string
  dx: number
  dy: number
  /** Folder drags only: the folder header under the cursor. */
  over: string | null
  /** Card drags: this group's geometry, frozen at pointer-down. */
  slots?: Slot[]
  /** Index it started at, and the index it would land on. */
  from?: number
  to?: number
  /** Another group's grid is under the cursor — dropping re-files instead. */
  refile?: string
  /** Released: gliding into the target slot before the commit lands. */
  settling?: boolean
}

/** Neighbours sliding aside, and the released card settling into its slot. */
const SLIDE_MS = 220
const SETTLE_MS = 200
/** Pixels of slop before a press becomes a drag, so a click stays a click. */
const SLOP = 5

export interface SortableHandlers {
  /** A group's new id order, first id identifying the group. */
  onReorder(order: string[]): void
  /** Card dropped over another group's grid: re-file it under that folder ('' = ungrouped). */
  onRefile(id: string, folder: string): void
  /** Folder header dropped on another folder header. */
  onFolderMove(dragName: string, targetName: string): void
}

/**
 * Wire a panel for reordering.
 *
 * Markup contract — three attributes, nothing else:
 *   - each group's grid container carries `data-cards={folder ?? ''}`
 *   - each card carries `data-card-id={id}` and `style={cardStyle(id)}`
 *   - each folder header carries `data-folder-id={name}` and `style={folderStyle(name)}`
 *
 * Handlers are read through a ref at pointer-up, so callers may pass fresh
 * closures over render-local state without re-arming anything.
 */
export function useSortable(handlers: SortableHandlers) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const onRef = useRef(handlers)
  onRef.current = handlers

  const beginDrag = (kind: 'card' | 'folder', id: string, e: React.PointerEvent) => {
    // Left button only, and never from a control: a card is mostly buttons.
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return
    const startX = e.clientX
    const startY = e.clientY
    let started = false
    const publish = (d: DragState | null) => { dragRef.current = d; setDrag(d) }

    if (kind === 'folder') {
      // Folders are a short vertical list; hit-testing the header under the
      // cursor is enough, and there is no grid geometry to preserve.
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!started && Math.hypot(dx, dy) < SLOP) return
        if (!started) { started = true; document.body.style.userSelect = 'none' }
        const raw = document.elementFromPoint(ev.clientX, ev.clientY)
          ?.closest('[data-folder-id]')?.getAttribute('data-folder-id') ?? null
        publish({ kind, id, dx, dy, over: raw === id ? null : raw })
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.userSelect = ''
        const over = dragRef.current?.over
        publish(null)
        if (started && over) onRef.current.onFolderMove(id, over)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }

    // Measure this card's own group once. See the file header for why this is
    // the whole trick.
    const host = (e.currentTarget as HTMLElement).closest('[data-cards]') as HTMLElement | null
    if (!host) return
    const slots: Slot[] = Array.from(host.querySelectorAll<HTMLElement>('[data-card-id]')).map(el => {
      const r = el.getBoundingClientRect()
      return { id: el.getAttribute('data-card-id') ?? '', left: r.left, top: r.top, w: r.width, h: r.height }
    })
    const from = slots.findIndex(s => s.id === id)
    if (from < 0) return
    const home = slots[from]!

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!started && Math.hypot(dx, dy) < SLOP) return
      if (!started) { started = true; document.body.style.userSelect = 'none' }
      // Aim with the CARD's centre, not the cursor: the grip sits at the far
      // right, and aiming from there would bias every decision a slot over.
      const cx = home.left + home.w / 2 + dx
      const cy = home.top + home.h / 2 + dy
      let to = from
      let best = Infinity
      slots.forEach((sl, i) => {
        const d = Math.hypot(sl.left + sl.w / 2 - cx, sl.top + sl.h / 2 - cy)
        if (d < best) { best = d; to = i }
      })
      // The one hit test left. It decides re-filing only and drives no preview,
      // so it has nothing to oscillate against.
      const overHost = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-cards]')
      const refile = overHost && overHost !== host
        ? overHost.getAttribute('data-cards') ?? undefined
        : undefined
      publish({ kind, id, dx, dy, over: null, slots, from, to, refile })
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      const cur = dragRef.current
      if (!started || !cur || cur.to === undefined) { publish(null); return }
      if (cur.refile !== undefined) { publish(null); onRef.current.onRefile(id, cur.refile); return }
      const to = cur.to
      // Glide into the slot rather than teleporting: committing straight away
      // snaps the card from under the cursor to its new home.
      publish({ ...cur, dx: slots[to]!.left - home.left, dy: slots[to]!.top - home.top, settling: true })
      const order = slots.map(sl => sl.id)
      order.splice(to, 0, order.splice(from, 1)[0]!)
      window.setTimeout(() => { publish(null); onRef.current.onReorder(order) }, SETTLE_MS)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Which slot each card occupies while a drag is in flight, by id. */
  const previewAt = (() => {
    if (drag?.kind !== 'card' || !drag.slots || drag.from === undefined || drag.to === undefined) return null
    if (drag.refile !== undefined) return null
    const ids = drag.slots.map(sl => sl.id)
    ids.splice(drag.to, 0, ids.splice(drag.from, 1)[0]!)
    return new Map(ids.map((x, j) => [x, j]))
  })()

  const cardStyle = (id: string): React.CSSProperties => {
    if (drag?.kind !== 'card' || !drag.slots) return {}
    const i = drag.slots.findIndex(sl => sl.id === id)
    if (i < 0) return {}
    if (id === drag.id) return {
      transform: `translate(${drag.dx}px, ${drag.dy}px)` + (drag.settling ? '' : ' scale(1.02)'),
      transition: drag.settling ? `transform ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1)` : 'none',
      position: 'relative', zIndex: 50, pointerEvents: 'none',
      cursor: 'grabbing', boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
    }
    const j = previewAt?.get(id)
    if (j === undefined) return {}
    return {
      transform: `translate(${drag.slots[j]!.left - drag.slots[i]!.left}px, ${drag.slots[j]!.top - drag.slots[i]!.top}px)`,
      transition: `transform ${SLIDE_MS}ms cubic-bezier(.2,.8,.2,1)`,
      position: 'relative',
    }
  }

  /** Folder headers translate directly — they never needed slot maths. */
  const folderStyle = (name: string): React.CSSProperties =>
    drag?.kind === 'folder' && drag.id === name
      ? {
          transform: `translate(${drag.dx}px, ${drag.dy}px)`,
          position: 'relative', zIndex: 50, pointerEvents: 'none',
          cursor: 'grabbing', boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
        }
      : {}

  /** Outline for the grid a card from another folder is hovering over. */
  const refileStyle = (folder: string | undefined): React.CSSProperties =>
    drag?.kind === 'card' && drag.refile === (folder ?? '')
      ? {
          outline: '2px dashed color-mix(in srgb, var(--accent) 60%, transparent)',
          outlineOffset: '6px', borderRadius: '0.5rem',
        }
      : {}

  return { drag, beginDrag, cardStyle, folderStyle, refileStyle }
}

/** The six-dot grip. Dragging starts here and nowhere else. */
export function DragHandle({ onPointerDown, title }: {
  onPointerDown: (e: React.PointerEvent) => void
  title: string
}) {
  return (
    <span
      onPointerDown={onPointerDown}
      title={title}
      className="drag-grip cursor-grab select-none inline-flex items-center justify-center"
      style={{ width: 18, height: 20, color: 'var(--muted)', touchAction: 'none' }}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden>
        <circle cx="2" cy="3" r="1.35" /><circle cx="8" cy="3" r="1.35" />
        <circle cx="2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" />
        <circle cx="2" cy="13" r="1.35" /><circle cx="8" cy="13" r="1.35" />
      </svg>
    </span>
  )
}
