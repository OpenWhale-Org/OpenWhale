'use client'

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { Modal } from './Modal'

/**
 * "You have unsaved changes" — one guard for the whole app.
 *
 * Any editor can register that it holds unsaved work; the guard mounted in the
 * shell is what actually stands in the way of leaving. Keeping the two apart
 * means a panel does not have to know how navigation happens, and a page with
 * two dirty editors asks once, naming both.
 */

const flags = new Map<string, string>()
const subscribers = new Set<() => void>()

/** Recomputed on write, not on read: useSyncExternalStore needs a stable identity. */
let snapshot: string[] = []
const EMPTY: string[] = []

function publish(): void {
  const labels = [...new Set(flags.values())].sort()
  snapshot = labels.length === 0 ? EMPTY : labels
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => { subscribers.delete(notify) }
}

/**
 * Declare that this component holds unsaved changes while `dirty`.
 *
 * The flag is dropped on unmount, so a panel that navigates away as part of
 * saving cannot leave a stale warning behind.
 */
export function useDirtyFlag(dirty: boolean, label: string): void {
  const id = useId()
  useEffect(() => {
    if (dirty) flags.set(id, label)
    else flags.delete(id)
    publish()
    return () => { flags.delete(id); publish() }
  }, [dirty, label, id])
}

export function useUnsavedLabels(): string[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY)
}

/**
 * Mount once, in the shell.
 *
 * Two exits need covering and they are covered differently. Closing or
 * reloading the tab can only raise the browser's own dialog (`beforeunload`),
 * whose wording is not ours to choose. An in-app link is ours: the click is
 * caught in the capture phase before Next's router sees it, held, and replayed
 * if the user says leave.
 */
export function UnsavedGuard() {
  const labels = useUnsavedLabels()
  const dirty = labels.length > 0
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  /** Set while WE navigate, so the click we replay is not caught again. */
  const leaving = useRef(false)

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!dirty) return
    const onClick = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0) return
      // A modified click opens a new tab — this one stays where it is.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const url = new URL(anchor.href, location.href)
      if (url.origin !== location.origin) return
      if (url.pathname === location.pathname && url.search === location.search) return
      e.preventDefault()
      e.stopPropagation()
      setPending(url.pathname + url.search + url.hash)
    }
    // Capture: Next's Link handles clicks on the bubble, and by then the
    // navigation has already started.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty])

  if (!pending) return null

  return (
    <Modal onClose={() => setPending(null)} maxWidth="26rem">
      <div className="p-4 flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Leave without saving?</h3>
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            {labels.join(' · ')} {labels.length > 1 ? 'have' : 'has'} unsaved changes. Leaving this page discards them.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPending(null)} autoFocus>Stay</button>
          <button
            type="button"
            className="btn btn-danger-solid btn-sm"
            onClick={() => {
              leaving.current = true
              const to = pending
              setPending(null)
              router.push(to)
              // The editors unmount on the new page and clear their own flags;
              // this only has to outlast the click that started the navigation.
              setTimeout(() => { leaving.current = false }, 0)
            }}
          >
            Leave
          </button>
        </div>
      </div>
    </Modal>
  )
}
