'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { usePathname, useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { useT, type MessageKey } from '@/i18n'

type T = ReturnType<typeof useT>

/**
 * The guided tour: a spotlight on a real control, and a step that only ends
 * when the thing it asked for has actually happened.
 *
 * Written this way rather than as a page of instructions because the two teach
 * different things. Prose teaches the reader what the words say; a spotlight on
 * the button they must press teaches them where it lives, and refusing to
 * advance until the credential exists teaches them what "done" means. It is the
 * difference between reading a manual and being shown.
 *
 * Targets are `data-tour="…"` attributes placed on the controls themselves, not
 * CSS selectors matched against markup. A selector like `.btn-primary:nth(2)`
 * is a promise that a layout will never change; an explicit hook is a promise
 * someone can see when they move the button.
 */

const KEY = 'ow:tour'

/** `welcome` is the card shown before step 1: what the tour is, take it or skip it. */
export type TourState = 'idle' | 'welcome' | 'running'

interface Step {
  /** Page this step happens on; the tour navigates there if you are elsewhere. */
  route: string
  /** `data-tour` value to spotlight. Absent = a step about the page as a whole. */
  target?: string
  title: MessageKey
  body: MessageKey
  /** Polled; true means the operator did the thing and the tour moves on. */
  done?: (w: World) => boolean
  /**
   * Advance as soon as this `data-tour` element EXISTS.
   *
   * The difference from `done` matters: opening a dialog changes nothing about
   * the world, so a world check would sit there waiting while the operator
   * stares at a form the tour has not followed them into. Most of a tutorial
   * is steps like that — pressed the button, now what.
   */
  until?: string
  /** Shown while waiting, so a step that cannot self-advance is never a dead end. */
  waitingFor?: MessageKey
  /** A button on the card that does part of the step for the operator. Returns what to show: a note, and a secret shown once. */
  action?: { label: MessageKey; run: (t: T) => ActionResult }
}

interface ActionResult {
  note: string
  /** A place to go next, rendered as a link. */
  link?: { label: string; href: string }
  /** Shown in full with a copy button — the only time it is displayed. */
  secret?: { label: string; value: string }
}

/** What the tour can observe about the system, refreshed while it runs. */
interface World {
  credentials: Array<{ name: string; type: string; publicData?: Record<string, unknown> }>
  accounts: Array<{ name: string; status: string; credential?: string }>
  instances: Array<{ id: string; name: string; strategyId: string; active: boolean }>
}

const EMPTY: World = { credentials: [], accounts: [], instances: [] }

const testnetCred = (w: World) =>
  w.credentials.find(c => c.type === 'hyperliquid' && c.publicData?.['testnet'] === true)
const testnetAccount = (w: World) => {
  const c = testnetCred(w)
  return c ? w.accounts.find(a => a.credential === c.name) : undefined
}
const tutorialInstance = (w: World) => w.instances.find(i => i.strategyId.endsWith('copy-trading'))

const STEPS: Step[] = [
  {
    route: '/credentials',
    target: 'nav-credentials',
    title: 'tour.creds.title',
    body: 'tour.creds.body',
  },
  {
    route: '/credentials',
    target: 'add-credential',
    title: 'tour.testnetKey.title',
    body: 'tour.testnetKey.body',
    until: 'credential-dialog',
    waitingFor: 'tour.testnetKey.waiting',
  },
  {
    route: '/credentials',
    target: 'credential-type-list',
    title: 'tour.chooseHl.title',
    body: 'tour.chooseHl.body',
    until: 'credential-form',
    waitingFor: 'tour.chooseHl.waiting',
  },
  {
    route: '/credentials',
    target: 'credential-form',
    title: 'tour.fillCred.title',
    body: 'tour.fillCred.body',
    done: w => testnetCred(w) !== undefined,
    waitingFor: 'tour.fillCred.waiting',
    action: {
      label: 'tour.gen.label',
      run: t => {
        const privateKey = generatePrivateKey()
        const address = privateKeyToAccount(privateKey).address
        window.dispatchEvent(new CustomEvent('ow-tour-fill', {
          detail: { name: t('tour.gen.name'), values: { walletAddress: address, privateKey, testnet: 'true' } },
        }))
        return {
          note: t('tour.gen.note', { address }),
          link: { label: t('tour.gen.link'), href: 'https://app.hyperliquid-testnet.xyz/drip' },
          secret: { label: t('tour.gen.secret'), value: privateKey },
        }
      },
    },
  },
  {
    route: '/accounts',
    target: 'nav-accounts',
    title: 'tour.account.title',
    body: 'tour.account.body',
  },
  {
    route: '/accounts',
    target: 'new-account',
    title: 'tour.accountForm.title',
    body: 'tour.accountForm.body',
    until: 'account-form',
    waitingFor: 'tour.accountForm.waiting',
  },
  {
    route: '/accounts',
    target: 'account-form',
    title: 'tour.bindKey.title',
    body: 'tour.bindKey.body',
    done: w => testnetAccount(w) !== undefined,
    waitingFor: 'tour.bindKey.waiting',
  },
  {
    route: '/instances',
    target: 'nav-instances',
    title: 'tour.strategies.title',
    body: 'tour.strategies.body',
  },
  {
    route: '/instances',
    target: 'new-instance',
    title: 'tour.picker.title',
    body: 'tour.picker.body',
    until: 'strategy-picker',
    waitingFor: 'tour.picker.waiting',
  },
  {
    route: '/instances',
    target: 'strategy-picker',
    title: 'tour.copyTrading.title',
    body: 'tour.copyTrading.body',
    until: 'instance-form',
    waitingFor: 'tour.copyTrading.waiting',
  },
  {
    route: '/instances',
    target: 'field-targetAddress',
    title: 'tour.target.title',
    body: 'tour.target.body',
  },
  {
    route: '/instances',
    target: 'field-ratio',
    title: 'tour.ratio.title',
    body: 'tour.ratio.body',
  },
  {
    route: '/instances',
    target: 'field-maxPositionUsd',
    title: 'tour.ceiling.title',
    body: 'tour.ceiling.body',
  },
  {
    route: '/instances',
    target: 'instance-form',
    title: 'tour.bindAccount.title',
    body: 'tour.bindAccount.body',
    done: w => tutorialInstance(w) !== undefined,
    waitingFor: 'tour.bindAccount.waiting',
  },
  {
    route: '/instances',
    title: 'tour.activate.title',
    body: 'tour.activate.body',
    done: w => tutorialInstance(w)?.active === true,
    waitingFor: 'tour.activate.waiting',
  },
]

export function startTour() {
  try { localStorage.setItem(KEY, 'welcome') } catch { /* private mode */ }
  window.dispatchEvent(new Event('ow-tour'))
}

export function tourWasSeen(): boolean {
  try { return localStorage.getItem(KEY) !== null } catch { return true }
}

export function Tour() {
  const t = useT()
  const [state, setState] = useState<TourState>('idle')
  const [i, setI] = useState(0)
  const [world, setWorld] = useState<World>(EMPTY)
  const [rect, setRect] = useState<DOMRect | null>(null)
  /** What the step's action reported, cleared when the step changes. */
  const [actionNote, setActionNote] = useState<ActionResult | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { setActionNote(null); setCopied(false) }, [i])
  const router = useRouter()
  const pathname = usePathname()
  const step = STEPS[i]

  // Read the stored state on mount, and whenever something asks to start.
  useEffect(() => {
    const sync = () => {
      let v: string | null = null
      try { v = localStorage.getItem(KEY) } catch { /* private mode */ }
      setState(v === 'running' ? 'running' : v === 'welcome' ? 'welcome' : 'idle')
    }
    sync()
    window.addEventListener('ow-tour', sync)
    return () => window.removeEventListener('ow-tour', sync)
  }, [])

  const stop = useCallback((how: 'done' | 'skipped') => {
    try { localStorage.setItem(KEY, how) } catch { /* private mode */ }
    setState('idle')
    setI(0)
  }, [])

  const begin = useCallback(() => {
    try { localStorage.setItem(KEY, 'running') } catch { /* private mode */ }
    setI(0)
    setState('running')
  }, [])

  /* Poll the world while a step is waiting on it. Two seconds, and only while
     the tour is up — this is a tutorial, not a dashboard. */
  useEffect(() => {
    if (state !== 'running') return
    let gone = false
    const pull = async () => {
      const [c, a, inst] = await Promise.all([
        fetch('/api/credentials').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch('/api/accounts').then(r => r.ok ? r.json() : {}).catch(() => ({})),
        fetch('/api/instances').then(r => r.ok ? r.json() : []).catch(() => []),
      ])
      if (gone) return
      setWorld({
        credentials: c as World['credentials'],
        accounts: (a as { accounts?: World['accounts'] }).accounts ?? [],
        instances: inst as World['instances'],
      })
    }
    void pull()
    const t = setInterval(() => void pull(), 2000)
    return () => { gone = true; clearInterval(t) }
  }, [state])

  // Auto-advance the moment the step's condition holds.
  useEffect(() => {
    if (state !== 'running' || !step?.done) return
    if (step.done(world)) setI(n => Math.min(n + 1, STEPS.length))
  }, [state, step, world])

  /* The `until` form: advance when an element appears. Polled rather than
     observed because the element may not exist yet to observe, and a
     MutationObserver on document.body for this is a bigger hammer. */
  useEffect(() => {
    if (state !== 'running' || !step?.until) return
    const t = setInterval(() => {
      if (document.querySelector(`[data-tour="${step.until}"]`)) setI(n => n + 1)
    }, 250)
    return () => clearInterval(t)
  }, [state, step])

  // Land on the page the step happens on.
  useEffect(() => {
    if (state !== 'running' || !step) return
    if (pathname !== step.route) router.push(step.route)
  }, [state, step, pathname, router])

  /* Track the target's box. On a rAF loop rather than a ResizeObserver: the
     spotlight has to follow scrolling, layout shifts AND the element appearing
     late, and one loop covers all three without three sets of listeners that
     each miss a case. */
  const raf = useRef(0)
  useEffect(() => {
    if (state !== 'running') return
    const tick = () => {
      raf.current = requestAnimationFrame(tick)
      const sel = step?.target
      if (!sel) { setRect(null); return }
      const el = document.querySelector(`[data-tour="${sel}"]`)
      setRect(el ? el.getBoundingClientRect() : null)
    }
    tick()
    return () => cancelAnimationFrame(raf.current)
  }, [state, step])

  const finished = state === 'running' && i >= STEPS.length
  const card = useMemo(() => placeCard(rect), [rect])

  if (state === 'idle' || typeof document === 'undefined') return null

  /* The welcome card: no spotlight, no navigation — a choice between the
     guided walkthrough and getting on with it. Sits in front of everything so
     the first thing a new operator meets is the offer, not step 1 of 15. */
  if (state === 'welcome') {
    return createPortal(
      <div className="ow-tour" aria-live="polite">
        <div className="ow-tour-dim" />
        {blockers(null).map((b, k) => <div key={k} className="ow-tour-block" style={b} />)}
        <div className="ow-tour-card ow-tour-welcome" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 420 }}>
          <div className="ow-tour-step">{t('tour.welcome.kicker')}</div>
          <h3>{t('tour.welcome.title')}</h3>
          <p>{t('tour.welcome.p1')}</p>
          <p>{t('tour.welcome.p2', { n: STEPS.length })}</p>
          <div className="ow-tour-actions">
            <button onClick={() => stop('skipped')}>{t('tour.skip')}</button>
            <span className="ow-tour-spacer" />
            <button className="ow-tour-primary" onClick={begin}>{t('tour.start')}</button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div className="ow-tour" aria-live="polite">
      {/* The cutout. A huge spread shadow on a transparent box dims everything
          EXCEPT the box — no SVG mask, and the hole tracks the element exactly. */}
      {rect && (
        <div
          className="ow-tour-hole"
          style={{
            left: rect.left - 6, top: rect.top - 6,
            width: rect.width + 12, height: rect.height + 12,
          }}
        />
      )}
      {!rect && !step?.target && <div className="ow-tour-dim" />}

      {/* Four bands around the hole, each swallowing clicks.
          Everything outside the spotlight is inert while the tour runs: a
          tutorial that lets you wander off mid-step is a tutorial narrating a
          screen you already left. It cannot be one full-screen blocker with a
          transparent hole — `pointer-events: none` on the hole passes the
          click to the blocker underneath, not to the page — so the gap has to
          be a real gap between four elements. */}
      {/* A step that WANTS a target but cannot find it blocks NOTHING. That
          case means the tour is lost — a renamed hook, a field that did not
          render — and a lost tour must not also lock the screen behind a
          full-page blocker, which is exactly what the fallback did. */}
      {(!step?.target || rect) && blockers(rect).map((b, k) => <div key={k} className="ow-tour-block" style={b} />)}

      <div className="ow-tour-card" style={card}>
        {finished ? (
          <>
            <div className="ow-tour-step">{t('tour.done.kicker')}</div>
            <h3>{t('tour.done.title')}</h3>
            <p>{t('tour.done.body')}</p>
            <div className="ow-tour-actions">
              <button className="ow-tour-primary" onClick={() => stop('done')}>{t('tour.finish')}</button>
            </div>
          </>
        ) : (
          <>
            <div className="ow-tour-step">{t('tour.stepOf', { n: i + 1, total: STEPS.length })}</div>
            <h3>{t(step!.title)}</h3>
            <p>{t(step!.body)}</p>
            {step!.action && (
              <p>
                <button className="btn btn-soft btn-sm" onClick={() => { setActionNote(step!.action!.run(t)); setCopied(false) }}>{t(step!.action.label)}</button>
              </p>
            )}
            {actionNote && (
              <p className="ow-tour-waiting">
                {actionNote.note}
                {actionNote.link && <> <a href={actionNote.link.href} target="_blank" rel="noopener noreferrer">{actionNote.link.label} ↗</a></>}
              </p>
            )}
            {actionNote?.secret && (
              <div className="ow-tour-secret">
                <div className="ow-tour-secret-label">{actionNote.secret.label}</div>
                <code>{actionNote.secret.value}</code>
                <button onClick={() => { void navigator.clipboard.writeText(actionNote.secret!.value).then(() => setCopied(true)) }}>
                  {copied ? t('tour.copied') : t('tour.copy')}
                </button>
              </div>
            )}
            {step!.done && !step!.done(world) && (
              <p className="ow-tour-waiting">{step!.waitingFor ? t(step!.waitingFor) : null}</p>
            )}
            {step!.target && !rect && (
              <p className="ow-tour-waiting">{t('tour.lost', { target: step!.target })}</p>
            )}
            <div className="ow-tour-actions">
              <button onClick={() => stop('skipped')}>{t('tour.skipTour')}</button>
              <span className="ow-tour-spacer" />
              {i > 0 && <button onClick={() => setI(n => n - 1)}>{t('tour.back')}</button>}
              {/* Always skippable forward. A step whose check cannot see what you
                  did is a trap if the only way on is that check. */}
              <button className="ow-tour-primary" onClick={() => setI(n => n + 1)}>
                {step!.done ? t('tour.skipStep') : t('tour.next')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The four inert bands that leave the spotlight — and only it — clickable.
 * With no target the whole screen is blocked and the card is the only way on.
 */
function blockers(rect: DOMRect | null): React.CSSProperties[] {
  if (typeof window === 'undefined') return []
  const { innerWidth: W, innerHeight: H } = window
  if (!rect) return [{ left: 0, top: 0, width: W, height: H }]
  const l = Math.max(0, rect.left - 6)
  const t = Math.max(0, rect.top - 6)
  const r = Math.min(W, rect.right + 6)
  const b = Math.min(H, rect.bottom + 6)
  return [
    { left: 0, top: 0, width: W, height: t },
    { left: 0, top: b, width: W, height: Math.max(0, H - b) },
    { left: 0, top: t, width: l, height: Math.max(0, b - t) },
    { left: r, top: t, width: Math.max(0, W - r), height: Math.max(0, b - t) },
  ]
}

/**
 * Put the card beside the spotlight, on whichever side has room.
 *
 * "Beside" and not "over": when the target is a dialog the card would land on
 * top of the very form it is describing, which is how the first version had
 * you reading instructions through a panel covering the inputs. If neither
 * side fits — a wide target, i.e. a dialog — it goes under or above instead.
 */
function placeCard(rect: DOMRect | null): React.CSSProperties {
  if (typeof window === 'undefined') return {}
  const W = 340
  const GAP = 20
  if (!rect) return { left: '50%', bottom: 40, transform: 'translateX(-50%)', width: W }

  const right = window.innerWidth - rect.right
  if (right > W + GAP) return { left: rect.right + GAP, top: clampTop(rect.top - 8), width: W }
  if (rect.left > W + GAP) return { left: rect.left - W - GAP, top: clampTop(rect.top - 8), width: W }

  // Nothing either side — sit in the taller of the bands above and below.
  const below = window.innerHeight - rect.bottom
  const left = Math.min(Math.max(16, rect.left), window.innerWidth - W - 16)
  return below > rect.top
    ? { left, top: rect.bottom + GAP, width: W }
    : { left, top: Math.max(16, rect.top - GAP - 240), width: W }
}

function clampTop(v: number): number {
  return Math.min(Math.max(16, v), window.innerHeight - 260)
}
