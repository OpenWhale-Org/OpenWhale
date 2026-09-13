'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { subscribeLiveEvents } from '@/lib/live-events'
import { fmtTime } from '@/lib/time'
import { useT } from '@/i18n'

/**
 * Every execution, announced in the corner.
 *
 * An execution is the moment the engine actually did something at a venue, and
 * until now you only saw it by sitting on the Executions page. These are for
 * the other 95% of the time: you are reading a chart, an instance fires, and
 * the corner tells you what and whether it worked.
 *
 * Deliberately modest about volume. A settlement fires dozens of executions in
 * a second, so the newest few are shown and everything behind them collapses
 * into one line saying how many more — a stack of forty toasts is not a
 * notification, it is a denial of service on your own screen.
 */

const PREF_KEY = 'ow:exec-toasts'
const PREF_EVENT = 'ow:exec-toasts-changed'
/** Toasts on screen at once; the rest are counted, not drawn. */
const MAX_SHOWN = 4
const DISMISS_MS = 6_000

export function executionToastsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try { return localStorage.getItem(PREF_KEY) !== 'off' } catch { return true }
}

export function setExecutionToastsEnabled(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off') } catch { /* private mode: this session only */ }
  window.dispatchEvent(new CustomEvent(PREF_EVENT))
}

interface Toast {
  id: string
  at: string
  status: string
  action: string
  symbol?: string
  instanceId?: string
  error?: string
}

const TONE: Record<string, string> = {
  success: 'var(--success)',
  failed: 'var(--danger)',
  skipped: 'var(--muted)',
  'dry-run': 'var(--warning)',
}

export function ExecutionToasts() {
  const t = useT()
  const [on, setOn] = useState(true)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [hidden, setHidden] = useState(0)

  useEffect(() => {
    const read = () => setOn(executionToastsEnabled())
    read()
    window.addEventListener(PREF_EVENT, read)
    window.addEventListener('storage', read)
    return () => { window.removeEventListener(PREF_EVENT, read); window.removeEventListener('storage', read) }
  }, [])

  useEffect(() => {
    if (!on) { setToasts([]); setHidden(0); return }
    return subscribeLiveEvents((event) => {
      const e = event as {
        type?: string
        execution?: {
          status?: string; executedAt?: string; error?: string
          instruction?: { action?: string; instanceId?: string; messageId?: string; params?: Record<string, unknown> }
        }
      }
      if (e.type !== 'execution' || !e.execution) return
      const x = e.execution
      const params = x.instruction?.params ?? {}
      const symbol = typeof params['symbol'] === 'string' ? params['symbol'] : undefined
      const toast: Toast = {
        id: `${x.instruction?.messageId ?? ''}:${x.executedAt ?? ''}:${Math.random().toString(36).slice(2, 7)}`,
        at: x.executedAt ?? new Date().toISOString(),
        status: x.status ?? 'success',
        action: x.instruction?.action ?? 'execution',
        ...(symbol ? { symbol } : {}),
        ...(x.instruction?.instanceId ? { instanceId: x.instruction.instanceId } : {}),
        ...(x.error ? { error: x.error } : {}),
      }
      setToasts((prev) => {
        const next = [toast, ...prev]
        if (next.length > MAX_SHOWN) setHidden(h => h + next.length - MAX_SHOWN)
        return next.slice(0, MAX_SHOWN)
      })
      setTimeout(() => setToasts(prev => prev.filter(p => p.id !== toast.id)), DISMISS_MS)
    })
  }, [on])

  useEffect(() => {
    if (toasts.length > 0 || hidden === 0) return
    const timer = setTimeout(() => setHidden(0), DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toasts.length, hidden])

  if (!on || (toasts.length === 0 && hidden === 0)) return null

  return (
    <div className="fixed left-4 bottom-4 z-[300] flex flex-col-reverse gap-2 pointer-events-none" style={{ maxWidth: 'min(26rem, 90vw)' }}>
      {hidden > 0 && (
        <div className="rounded-md px-3 py-1.5 text-xs pointer-events-auto"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
          {t('toast.more', { n: hidden })}
        </div>
      )}
      {toasts.map(toast => (
        <Link
          key={toast.id}
          href={toast.instanceId ? `/instances/${toast.instanceId}` : '/executions'}
          onClick={() => setToasts(prev => prev.filter(p => p.id !== toast.id))}
          className="rounded-md px-3 py-2 text-xs flex items-start gap-2 pointer-events-auto shadow-lg"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        >
          <span className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ background: TONE[toast.status] ?? 'var(--muted)' }} />
          <span className="min-w-0">
            <span className="font-medium">{toast.action}</span>
            {toast.symbol && <span className="font-mono ml-1.5">{toast.symbol}</span>}
            <span className="ml-1.5" style={{ color: TONE[toast.status] ?? 'var(--muted)' }}>{toast.status}</span>
            <span className="ml-1.5" style={{ color: 'var(--muted)' }}>{fmtTime(toast.at)}</span>
            {toast.error && <span className="block truncate" style={{ color: 'var(--danger)' }}>{toast.error}</span>}
          </span>
        </Link>
      ))}
    </div>
  )
}
