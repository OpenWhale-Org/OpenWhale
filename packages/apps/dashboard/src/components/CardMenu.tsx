'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The kebab menu every card header ends with, and the folder picker inside it.
 *
 * Cards on different pages carry different actions, but they should not carry
 * them differently: one ⋯ button in the same corner, one popover of the same
 * shape, the grip last. What varies is the item list, so that is all a caller
 * supplies. Filing a card away used to be a visible dropdown on Scripts and a
 * menu section on Strategies — same operation, two affordances, two places to
 * look.
 */

export const MENU_ITEM = 'w-full text-left px-3 py-1.5 text-xs'

/** ⋯ trigger plus the popover it opens. Closes on click-away. */
export function KebabMenu({ children, title = 'More' }: {
  /** Receives `close` so an item can dismiss the menu after acting. */
  children: (close: () => void) => React.ReactNode
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-6 h-6 rounded-md flex items-center justify-center leading-none"
        style={{ color: 'var(--muted)' }}
        title={title}
        aria-label="More actions"
      >
        ⋯
      </button>
      {open && (
        <div
          className="absolute right-0 z-[100] mt-1 rounded-md shadow-lg flex flex-col py-1"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '12rem' }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** The FOLDER block: pick one, clear it, or type a new one. */
export function FolderSection({ current, folders, onPick, close }: {
  current?: string | undefined
  folders: string[]
  onPick: (name: string) => void
  close: () => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <>
      <div className="px-3 pt-2 pb-1 text-xs" style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>FOLDER</div>
      {folders.map(f => (
        <button key={f} type="button" className={`${MENU_ITEM} flex items-center gap-2`} style={{ color: 'var(--foreground)' }}
          onClick={() => { onPick(f); close() }}>
          <span style={{ color: f === current ? 'var(--accent)' : 'var(--muted)' }}>{f === current ? '●' : '○'}</span>
          📁 {f}
        </button>
      ))}
      {current && (
        <button type="button" className={MENU_ITEM} style={{ color: 'var(--muted)' }}
          onClick={() => { onPick(''); close() }}>
          Remove from folder
        </button>
      )}
      <form className="flex gap-1 px-2 py-1"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onPick(draft.trim()); setDraft(''); close() } }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New folder…"
          className="flex-1 min-w-0 rounded px-2 py-1 text-xs"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
        <button type="submit" className="text-xs px-2 rounded" style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}>Add</button>
      </form>
    </>
  )
}
