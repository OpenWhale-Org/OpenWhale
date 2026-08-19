'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { startTour } from '@/components/Tour'

/**
 * First run: from nothing to a strategy that is actually trading.
 *
 * Four steps, and every one of them checks the real world rather than
 * remembering that you clicked something. A checklist that ticks itself off on
 * click teaches the click, not the system — and when the strategy then fails
 * to activate, the tour has already told you it went fine.
 *
 * Deliberately on the Hyperliquid TESTNET. The shortest honest path to a live
 * strategy is one where a mistake costs nothing, and HL is the only venue here
 * whose testnet hands out funds to anyone with an address.
 */

const DISMISS_KEY = 'ow:onboarded'

/** The tutorial's subject. Chosen for how little it needs, not for what it earns. */
const TUTORIAL_STRATEGY = 'examples/copy-trading'

interface Credential { id: string; name: string; type: string; publicData?: Record<string, unknown> }
interface Account { name: string; type?: string; status: string; credential?: string; kind?: string }
interface Instance { id: string; name: string; strategyId: string; active: boolean }

export function StartClient() {
  const [creds, setCreds] = useState<Credential[] | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [instances, setInstances] = useState<Instance[] | null>(null)

  const refresh = useCallback(async () => {
    const [c, a, i] = await Promise.all([
      fetch('/api/credentials').then(r => r.ok ? r.json() : []).catch(() => []),
      // /api/accounts answers { accounts, implementations, snapshots } — not a
      // bare list like the other two.
      fetch('/api/accounts').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/instances').then(r => r.ok ? r.json() : []).catch(() => []),
    ])
    setCreds(c as Credential[])
    setAccounts(((a as { accounts?: Account[] }).accounts) ?? [])
    setInstances(i as Instance[])
  }, [])

  useEffect(() => {
    void refresh()
    // Steps complete on other pages, so re-check when the tab comes back.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => { try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ } }, [])

  const loading = creds === null || accounts === null || instances === null

  /* Testnet specifically: a mainnet HL credential means you are past this
     tutorial, not that you have finished step one of it. */
  const testnetCred = (creds ?? []).find(c =>
    c.type === 'hyperliquid' && c.publicData?.['testnet'] === true)
  const testnetAccount = (accounts ?? []).find(a =>
    a.credential !== undefined && a.credential === testnetCred?.name)
  const tutorialInstance = (instances ?? []).find(i => i.strategyId === TUTORIAL_STRATEGY)
  const running = tutorialInstance?.active === true

  const steps = [
    {
      title: 'A testnet credential',
      done: testnetCred !== undefined,
      body: (
        <>
          <p>
            Hyperliquid&apos;s testnet is a full copy of the exchange with worthless money in it.
            Everything below behaves exactly as it will on mainnet, and a mistake costs nothing.
          </p>
          <ol className="list-decimal ml-4 flex flex-col gap-1.5">
            <li>
              Open{' '}
              <a href="https://app.hyperliquid-testnet.xyz/drip" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
                app.hyperliquid-testnet.xyz/drip
              </a>{' '}
              and connect a wallet — the faucet sends mock USDC to it.
            </li>
            <li>
              In that wallet, export the private key of the address you just funded, or generate an
              API wallet from the testnet UI (Settings → API). An API wallet is the safer of the two:
              it can trade but cannot withdraw.
            </li>
            <li>
              On the Credentials page choose <b>Hyperliquid</b>, paste the wallet address and private
              key, and <b>turn Testnet on</b>. That toggle is the whole difference between this
              tutorial and real money.
            </li>
          </ol>
          {testnetCred && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              Found <b>{testnetCred.name}</b> — a Hyperliquid credential with testnet on.
            </p>
          )}
        </>
      ),
      action: { href: '/credentials', label: testnetCred ? 'Credentials' : 'Add the credential' },
    },
    {
      title: 'An account',
      done: testnetAccount !== undefined,
      body: (
        <>
          <p>
            A credential is a key; an <b>account</b> is what strategies actually read and executors
            write. It is an implementation (what kind of account) bound to a credential (whose).
          </p>
          <p>
            On the Accounts page create one with <b>Perp Account</b> and bind it to your testnet
            credential. It should come up <b>ready</b> — if it does not, the credential is wrong and
            nothing further will work.
          </p>
          {testnetAccount && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              Found <b>{testnetAccount.name}</b>, bound to {testnetAccount.credential} · {testnetAccount.status}.
            </p>
          )}
        </>
      ),
      action: { href: '/accounts', label: testnetAccount ? 'Accounts' : 'Create the account' },
      blocked: testnetCred === undefined,
    },
    {
      title: 'A strategy instance',
      done: tutorialInstance !== undefined,
      body: (
        <>
          <p>
            <b>Copy trading</b> is the one to start with: it mirrors another Hyperliquid address&apos;s
            fills at a fraction of their size. Hyperliquid publishes every account&apos;s trades, so it
            needs no signal of its own — you can watch it work within minutes instead of waiting for
            a mean-reversion setup that may not come today.
          </p>
          <p>
            New Instance → <b>copy-trading</b>, bind the account from step 2, and set{' '}
            <code>traderAddress</code> to whichever address you want to follow. Keep{' '}
            <code>maxNotionalUsd</code> small — the point right now is to see an order appear, not to
            size a position.
          </p>
          {tutorialInstance && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              Found <b>{tutorialInstance.name}</b>.
            </p>
          )}
        </>
      ),
      action: { href: '/instances', label: tutorialInstance ? 'Strategies' : 'Create the instance' },
      blocked: testnetAccount === undefined,
    },
    {
      title: 'Start it',
      done: running,
      body: (
        <>
          <p>
            Activating subscribes the monitors the strategy declared and puts its executors under the
            queue. Watch it on the instance&apos;s own board: runs, the instructions each run produced,
            and the fills that came back.
          </p>
          <p style={{ color: 'var(--muted)' }}>
            Nothing here trades until the address you are following does. A quiet board is the
            strategy working, not a strategy broken.
          </p>
          {running && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              <b>{tutorialInstance?.name}</b> is running. That is the whole loop — credential,
              account, strategy, live.
            </p>
          )}
        </>
      ),
      action: tutorialInstance
        ? { href: `/instances/${tutorialInstance.id}`, label: running ? 'Open its board' : 'Activate it' }
        : { href: '/instances', label: 'Strategies' },
      blocked: tutorialInstance === undefined,
    },
  ]

  const doneCount = steps.filter(s => s.done).length

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Getting started</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          From an empty install to a strategy that is trading — on a testnet, so the first mistake is free.
        </p>
      </div>

      <button
        onClick={() => startTour()}
        className="hoverable rounded-lg px-4 py-3 flex items-center gap-3 text-left"
        style={{ background: 'var(--accent)', color: '#fff', border: 'none' }}
      >
        <span className="text-lg">▶</span>
        <span className="flex-1">
          <span className="block text-sm font-medium">Take the guided tour</span>
          <span className="block text-xs" style={{ opacity: 0.85 }}>
            Walks you through the real controls, one at a time, and waits until each step has
            actually happened. Skippable at any point.
          </span>
        </span>
      </button>

      <div className="flex items-center gap-3">
        <div className="rounded-full overflow-hidden flex-1" style={{ height: 6, background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div style={{ width: `${(doneCount / steps.length) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 240ms ease' }} />
        </div>
        <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
          {loading ? 'checking…' : `${doneCount} of ${steps.length}`}
        </span>
      </div>

      {steps.map((step, i) => (
        <section
          key={step.title}
          className="rounded-lg p-4 flex flex-col gap-2"
          style={{
            background: 'var(--surface)',
            border: `1px solid ${step.done ? 'color-mix(in srgb, var(--success, #22c55e) 40%, transparent)' : 'var(--border)'}`,
            opacity: step.blocked && !step.done ? 0.55 : 1,
          }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="w-6 h-6 rounded-full grid place-items-center text-xs shrink-0"
              style={step.done
                ? { background: 'var(--success, #22c55e)', color: '#0b0e18' }
                : { border: '1px solid var(--border)', color: 'var(--muted)' }}
            >
              {step.done ? '✓' : i + 1}
            </span>
            <h2 className="text-base font-medium flex-1">{step.title}</h2>
            <Link
              href={step.action.href}
              className="hoverable hoverable-flat h-8 px-3 rounded-md text-xs flex items-center shrink-0"
              style={step.done || step.blocked
                ? { border: '1px solid var(--border)', color: 'var(--muted)' }
                : { background: 'var(--accent)', color: '#fff' }}
            >
              {step.action.label} ↗
            </Link>
          </div>
          <div className="text-sm flex flex-col gap-2 pl-8.5" style={{ color: 'var(--foreground)' }}>
            {step.body}
          </div>
        </section>
      ))}

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Both this checklist and the tour read the real state — nothing is ticked off because you
        clicked it. Reachable any time from Getting started in the sidebar.
      </p>
    </div>
  )
}

/** Whether the tour has ever been opened. Read by the overview's first-run nudge. */
export function hasOnboarded(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return true }
}
