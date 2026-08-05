'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * Overlay shell for dialogs: backdrop, Esc, and a scroll-locked page beneath.
 *
 * Dismissal lives here and only here — a dialog whose body also listened for
 * Esc would close two steps at once when it is a wizard.
 */

interface ModalChrome {
  maximized: boolean
  toggleMaximized: () => void
}

const ChromeContext = createContext<ModalChrome | null>(null)

/**
 * The maximise control, for the dialog's own header to place beside its other
 * actions. Renders nothing outside a maximisable Modal, so a header can carry
 * it unconditionally.
 */
export function ModalMaximizeButton({ className = '' }: { className?: string }) {
  const chrome = useContext(ChromeContext)
  if (!chrome) return null
  const { maximized, toggleMaximized } = chrome
  return (
    <button
      type="button"
      onClick={toggleMaximized}
      title={maximized ? 'Restore' : 'Maximize'}
      aria-label={maximized ? 'Restore' : 'Maximize'}
      className={`btn btn-secondary btn-sm shrink-0 ${className}`}
      style={{ padding: '0 0.5rem' }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {maximized ? (
          <>
            <rect x="3" y="8" width="13" height="13" rx="2" />
            <path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" />
          </>
        ) : (
          <rect x="3" y="3" width="18" height="18" rx="2" />
        )}
      </svg>
    </button>
  )
}

export function Modal({ onClose, maxWidth = '48rem', height, maximizable, persistKey, children }: {
  onClose: () => void
  /** Cap on the panel width. Keep it stable across a wizard's steps. */
  maxWidth?: string
  /** Fixed panel height — give one when the body scrolls internally. */
  height?: string
  /** Offer a maximise toggle; place `<ModalMaximizeButton/>` in your header. */
  maximizable?: boolean
  /** localStorage key that remembers the maximised choice across openings. */
  persistKey?: string
  children: React.ReactNode
}) {
  const [maximized, setMaximized] = useState(false)

  // Read after mount, not during render: the server has no localStorage, and a
  // maximised first paint that the server rendered small is a hydration error.
  useEffect(() => {
    if (!persistKey) return
    try {
      if (window.localStorage.getItem(persistKey) === '1') setMaximized(true)
    } catch { /* private mode — the default stands */ }
  }, [persistKey])

  const toggleMaximized = useCallback(() => {
    setMaximized((v) => {
      const next = !v
      if (persistKey) {
        try { window.localStorage.setItem(persistKey, next ? '1' : '0') } catch { /* ignore */ }
      }
      return next
    })
  }, [persistKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  const full = maximizable && maximized

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      // mousedown, not click: a drag that starts inside the panel and ends on
      // the backdrop (selecting text, dragging a slider) must not dismiss it.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-lg flex flex-col w-full min-h-0 overflow-hidden"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          // The panel sits inside the overlay's 1rem padding, so "full" is the
          // viewport minus that — never taller than the screen it renders on.
          maxWidth: full ? '100%' : maxWidth,
          height: full ? 'calc(100vh - 2rem)' : height,
          transition: 'max-width 120ms ease, height 120ms ease',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ChromeContext.Provider value={maximizable ? { maximized, toggleMaximized } : null}>
          {children}
        </ChromeContext.Provider>
      </div>
    </div>
  )
}
