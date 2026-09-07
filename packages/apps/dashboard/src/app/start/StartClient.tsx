'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { startTour } from '@/components/Tour'
import { useT } from '@/i18n'

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

/** Render `**bold**` and `` `code` `` markers in a catalogue string, so a sentence stays one key. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean)
  return (
    <>
      {parts.map((part, i) => part.startsWith('**')
        ? <b key={i}>{part.slice(2, -2)}</b>
        : part.startsWith('`')
          ? <code key={i}>{part.slice(1, -1)}</code>
          : <span key={i}>{part}</span>)}
    </>
  )
}

export function StartClient() {
  const t = useT()
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
      title: t('start.cred.title'),
      done: testnetCred !== undefined,
      body: (
        <>
          <p>{t('start.cred.p1')}</p>
          <ol className="list-decimal ml-4 flex flex-col gap-1.5">
            <li>
              {t('start.cred.li1.before')}
              <a href="https://app.hyperliquid-testnet.xyz/drip" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
                app.hyperliquid-testnet.xyz/drip
              </a>
              {t('start.cred.li1.after')}
            </li>
            <li>{t('start.cred.li2')}</li>
            <li><Rich text={t('start.cred.li3')} /></li>
          </ol>
          {testnetCred && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              <Rich text={t('start.cred.found', { name: testnetCred.name })} />
            </p>
          )}
        </>
      ),
      action: { href: '/credentials', label: testnetCred ? t('start.cred.go') : t('start.cred.add') },
    },
    {
      title: t('start.account.title'),
      done: testnetAccount !== undefined,
      body: (
        <>
          <p><Rich text={t('start.account.p1')} /></p>
          <p><Rich text={t('start.account.p2')} /></p>
          {testnetAccount && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              <Rich text={t('start.account.found', { name: testnetAccount.name, credential: testnetAccount.credential ?? '', status: testnetAccount.status })} />
            </p>
          )}
        </>
      ),
      action: { href: '/accounts', label: testnetAccount ? t('start.account.go') : t('start.account.create') },
      blocked: testnetCred === undefined,
    },
    {
      title: t('start.instance.title'),
      done: tutorialInstance !== undefined,
      body: (
        <>
          <p><Rich text={t('start.instance.p1')} /></p>
          <p><Rich text={t('start.instance.p2')} /></p>
          {tutorialInstance && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              <Rich text={t('start.instance.found', { name: tutorialInstance.name })} />
            </p>
          )}
        </>
      ),
      action: { href: '/instances', label: tutorialInstance ? t('start.instance.go') : t('start.instance.create') },
      blocked: testnetAccount === undefined,
    },
    {
      title: t('start.run.title'),
      done: running,
      body: (
        <>
          <p>{t('start.run.p1')}</p>
          <p style={{ color: 'var(--muted)' }}>{t('start.run.p2')}</p>
          {running && (
            <p style={{ color: 'var(--success, #4ade80)' }}>
              <Rich text={t('start.run.running', { name: tutorialInstance?.name ?? '' })} />
            </p>
          )}
        </>
      ),
      action: tutorialInstance
        ? { href: `/instances/${tutorialInstance.id}`, label: running ? t('start.run.board') : t('start.run.activate') }
        : { href: '/instances', label: t('start.instance.go') },
      blocked: tutorialInstance === undefined,
    },
  ]

  const doneCount = steps.filter(s => s.done).length

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">{t('start.title')}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>{t('start.subtitle')}</p>
      </div>

      <button
        onClick={() => startTour()}
        className="hoverable rounded-lg px-4 py-3 flex items-center gap-3 text-left"
        style={{ background: 'var(--accent)', color: '#fff', border: 'none' }}
      >
        <span className="text-lg">▶</span>
        <span className="flex-1">
          <span className="block text-sm font-medium">{t('start.tour.title')}</span>
          <span className="block text-xs" style={{ opacity: 0.85 }}>{t('start.tour.body')}</span>
        </span>
      </button>

      <div className="flex items-center gap-3">
        <div className="rounded-full overflow-hidden flex-1" style={{ height: 6, background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div style={{ width: `${(doneCount / steps.length) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 240ms ease' }} />
        </div>
        <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
          {loading ? t('start.checking') : t('start.progress', { done: doneCount, total: steps.length })}
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

      <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('start.footer')}</p>
    </div>
  )
}

/** Whether the tour has ever been opened. Read by the overview's first-run nudge. */
export function hasOnboarded(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return true }
}
