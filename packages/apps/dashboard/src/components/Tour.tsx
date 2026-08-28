'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { usePathname, useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'

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
  title: string
  body: string
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
  waitingFor?: string
  /** A button on the card that does part of the step for the operator. Returns a note to show. */
  action?: { label: string; run: () => string | undefined }
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
    title: 'Credentials come first',
    body: 'A credential is a key to a venue. Everything else — accounts, strategies, orders — hangs off one. This is where they live.',
  },
  {
    route: '/credentials',
    target: 'add-credential',
    title: 'Get a testnet key first',
    body: 'Before pressing this: fund a wallet at app.hyperliquid-testnet.xyz/drip — the faucet gives mock USDC to any address. Then export that address’s key, or generate an API wallet from the testnet UI. An API wallet can trade but cannot withdraw, which is the one you want.',
    until: 'credential-dialog',
    waitingFor: 'Press + Add Credential when you have a key…',
  },
  {
    route: '/credentials',
    target: 'credential-type-list',
    title: 'Choose Hyperliquid',
    body: 'This list is every venue and model provider the install knows about. Find Hyperliquid — the search box narrows it — and click it.',
    until: 'credential-form',
    waitingFor: 'Waiting for you to pick a type…',
  },
  {
    route: '/credentials',
    target: 'credential-form',
    title: 'Fill it in, and turn Testnet ON',
    body: 'Generate a wallet here — it fills the form with a fresh key and Testnet on — or paste your own. Fund the address at app.hyperliquid-testnet.xyz/drip (mock USDC, any address), then Save. Testnet is the entire difference between this tutorial and real money.',
    done: w => testnetCred(w) !== undefined,
    waitingFor: 'Waiting for a Hyperliquid credential with Testnet on…',
    action: {
      label: 'Generate a testnet wallet',
      run: () => {
        const privateKey = generatePrivateKey()
        const address = privateKeyToAccount(privateKey).address
        window.dispatchEvent(new CustomEvent('ow-tour-fill', {
          detail: { name: 'Tutorial testnet', values: { walletAddress: address, privateKey, testnet: 'true' } },
        }))
        return `Filled in ${address}. Fund it at app.hyperliquid-testnet.xyz/drip, then Save. The key is stored encrypted with the credential — nowhere else.`
      },
    },
  },
  {
    route: '/accounts',
    target: 'nav-accounts',
    title: 'Now an account',
    body: 'A credential is a key; an account is the thing strategies read and executors write. It is an implementation bound to a credential.',
  },
  {
    route: '/accounts',
    target: 'new-account',
    title: 'Open the account form',
    body: 'Press ＋ New account. The form takes over the right-hand pane.',
    until: 'account-form',
    waitingFor: 'Press ＋ New account…',
  },
  {
    route: '/accounts',
    target: 'account-form',
    title: 'Name it and bind the key',
    body: 'Any name you will recognise. Leave the implementation on Perp Account, and in the last dropdown pick the testnet credential you just created — that is what turns an empty shell into an account that can trade. Then Create.',
    done: w => testnetAccount(w) !== undefined,
    waitingFor: 'Waiting for an account bound to that credential…',
  },
  {
    route: '/instances',
    target: 'nav-instances',
    title: 'Strategies',
    body: 'A strategy is code plus parameters plus an account. One strategy can run many instances, each on its own account and settings.',
  },
  {
    route: '/instances',
    target: 'new-instance',
    title: 'Open the strategy picker',
    body: 'Press + New Instance. Choosing the strategy comes first, configuring it second.',
    until: 'strategy-picker',
    waitingFor: 'Press + New Instance…',
  },
  {
    route: '/instances',
    target: 'strategy-picker',
    title: 'Pick copy-trading',
    body: 'It mirrors another Hyperliquid address at a fraction of their size. Hyperliquid publishes every account’s fills, so it needs no signal of its own — which is why it is the one to learn on: you can watch it work within minutes instead of waiting for a setup that may not come today.',
    until: 'instance-form',
    waitingFor: 'Waiting for you to choose a strategy…',
  },
  {
    route: '/instances',
    target: 'field-targetAddress',
    title: 'Who are you copying?',
    body: 'The one decision copy trading actually makes. Press “Suggest a trader” for the top of Hyperliquid’s public leaderboard over the last 30 days, or paste any address you already follow. The list is a shortcut, not a whitelist — and one good month is not a good trader.',
  },
  {
    route: '/instances',
    target: 'field-ratio',
    title: 'How much of their size',
    body: '0.5 mirrors half of every trade they make. Their account is almost certainly far larger than your testnet one, so start smaller than feels interesting — you are checking that orders appear, not competing with them.',
  },
  {
    route: '/instances',
    target: 'field-maxPositionUsd',
    title: 'And a hard ceiling',
    body: 'The cap on |exposure| per symbol, regardless of what the ratio works out to. This is the line the strategy cannot cross however wrong everything else goes — the one number worth setting deliberately even on a testnet.',
  },
  {
    route: '/instances',
    target: 'instance-form',
    title: 'Bind the account and save',
    body: 'Pick your testnet account in the Accounts slot near the top, then Activate. Everything else already has a sensible default.',
    done: w => tutorialInstance(w) !== undefined,
    waitingFor: 'Waiting for a copy-trading instance…',
  },
  {
    route: '/instances',
    title: 'Start it',
    body: 'Activate the instance. That subscribes the monitors it declared and puts its executors under the queue. Nothing trades until the address you follow does — a quiet board is the strategy working, not a strategy broken. One caveat worth knowing now: the fills you copy come from MAINNET, while your orders go to testnet, and testnet lists 27 fewer contracts (XRP, LINK, UNI, DOT and others). A trade in one of those produces a run and an instruction but no fill. That is the venue, not your setup.',
    done: w => tutorialInstance(w)?.active === true,
    waitingFor: 'Waiting for the instance to go active…',
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
  const [state, setState] = useState<TourState>('idle')
  const [i, setI] = useState(0)
  const [world, setWorld] = useState<World>(EMPTY)
  const [rect, setRect] = useState<DOMRect | null>(null)
  /** What the step's action reported, cleared when the step changes. */
  const [actionNote, setActionNote] = useState('')
  useEffect(() => { setActionNote('') }, [i])
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
          <div className="ow-tour-step">Welcome</div>
          <h3>Welcome to OpenWhale</h3>
          <p>
            An engine that runs trading strategies: a credential opens a venue, an account binds it,
            a strategy instance trades on it.
          </p>
          <p>
            The guided tour walks through that loop once, end to end, with a copy-trading strategy on
            the Hyperliquid testnet — {STEPS.length} steps, no real funds. You can leave it at any point.
          </p>
          <div className="ow-tour-actions">
            <button onClick={() => stop('skipped')}>Skip</button>
            <span className="ow-tour-spacer" />
            <button className="ow-tour-primary" onClick={begin}>Start the tour</button>
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
            <div className="ow-tour-step">Done</div>
            <h3>That is the whole loop</h3>
            <p>Credential, account, strategy, live. Everything else in OpenWhale is a variation on those four.</p>
            <div className="ow-tour-actions">
              <button className="ow-tour-primary" onClick={() => stop('done')}>Finish</button>
            </div>
          </>
        ) : (
          <>
            <div className="ow-tour-step">Step {i + 1} of {STEPS.length}</div>
            <h3>{step!.title}</h3>
            <p>{step!.body}</p>
            {step!.action && (
              <p>
                <button className="ow-tour-primary" onClick={() => setActionNote(step!.action!.run() ?? '')}>{step!.action.label}</button>
              </p>
            )}
            {actionNote && <p className="ow-tour-waiting">{actionNote}</p>}
            {step!.done && !step!.done(world) && (
              <p className="ow-tour-waiting">{step!.waitingFor}</p>
            )}
            {step!.target && !rect && (
              <p className="ow-tour-waiting">
                Cannot find “{step!.target}” on this page — the tour is out of step with the UI.
                Nothing is blocked; press Next to move on.
              </p>
            )}
            <div className="ow-tour-actions">
              <button onClick={() => stop('skipped')}>Skip tour</button>
              <span className="ow-tour-spacer" />
              {i > 0 && <button onClick={() => setI(n => n - 1)}>Back</button>}
              {/* Always skippable forward. A step whose check cannot see what you
                  did is a trap if the only way on is that check. */}
              <button className="ow-tour-primary" onClick={() => setI(n => n + 1)}>
                {step!.done ? 'Skip step' : 'Next'}
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
