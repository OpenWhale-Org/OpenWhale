'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Undo/redo over a single piece of edited state.
 *
 * Keystrokes are coalesced: an edit that lands within `coalesceMs` of the last
 * one replaces it instead of pushing a new entry, so undo steps back over a
 * number someone retyped rather than over each digit. Anything the user would
 * call a single act — an import, a preset, a JSON paste — should pass
 * `{ coalesce: false }` so it becomes one undo of its own.
 */
export interface History<T> {
  state: T
  set: (next: T, options?: { coalesce?: boolean }) => void
  /** Replace the state and drop the history — for a reload, not an edit. */
  reset: (next: T) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

interface Stack<T> {
  past: T[]
  present: T
  future: T[]
}

/** Past entries kept. A form has no use for a thousand steps, and each is a copy. */
const DEPTH = 100

export function useHistory<T>(initial: T, coalesceMs = 600): History<T> {
  // One state object, updated only by pure reducers: a side effect inside a
  // setState updater would be run twice by StrictMode and push each edit twice.
  const [stack, setStack] = useState<Stack<T>>({ past: [], present: initial, future: [] })
  const lastEdit = useRef(0)

  const set = useCallback((next: T, options?: { coalesce?: boolean }) => {
    const now = Date.now()
    const merge = (options?.coalesce ?? true) && now - lastEdit.current < coalesceMs
    lastEdit.current = now
    setStack(s => merge
      ? { past: s.past, present: next, future: [] }
      : { past: [...s.past, s.present].slice(-DEPTH), present: next, future: [] })
  }, [coalesceMs])

  const reset = useCallback((next: T) => {
    lastEdit.current = 0
    setStack({ past: [], present: next, future: [] })
  }, [])

  const undo = useCallback(() => {
    lastEdit.current = 0
    setStack(s => s.past.length === 0 ? s : {
      past: s.past.slice(0, -1),
      present: s.past[s.past.length - 1]!,
      future: [s.present, ...s.future],
    })
  }, [])

  const redo = useCallback(() => {
    lastEdit.current = 0
    setStack(s => s.future.length === 0 ? s : {
      past: [...s.past, s.present].slice(-DEPTH),
      present: s.future[0]!,
      future: s.future.slice(1),
    })
  }, [])

  return {
    state: stack.present,
    set,
    reset,
    undo,
    redo,
    canUndo: stack.past.length > 0,
    canRedo: stack.future.length > 0,
  }
}

/**
 * ⌘Z / ⌘⇧Z (Ctrl on Windows) while `active`.
 *
 * Typing in a field keeps the browser's own undo — a form-wide undo that also
 * swallowed text undo inside the input someone is typing in would feel broken —
 * so the shortcut only fires when focus is not in an editable element.
 */
export function useUndoShortcuts(active: boolean, undo: () => void, redo: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, undo, redo])
}
