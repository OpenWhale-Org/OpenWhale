import { z } from 'zod'
import type { ScriptDefinition } from '@openwhaleorg/core'
import type { AccountView } from '@openwhaleorg/core'

/**
 * Does this venue accept an order-priority fee, and on which markets?
 *
 * Hyperliquid prices order sequencing through `grouping: {"p": N}` on the order
 * action (p / 1e8 = the rate). ccxt cannot send it — `grouping` is a hardcoded
 * string there — so the adapter has to assemble and sign the action itself.
 * Before trusting that path with a settlement ladder, it is worth confirming
 * the venue actually accepts it on the market you trade.
 *
 * ── Why this costs nothing ──────────────────────────────────────────────────
 * An IOC's priority fee is charged on the FILLED notional. An IOC that cannot
 * fill therefore pays no priority fee and no trading fee — but the venue still
 * has to parse and validate the whole action, including the grouping. So a
 * deliberately unfillable IOC answers "is this supported?" for free.
 *
 * (ALO cannot be used for this: its fee is charged on the RESTING notional at
 * placement, whether or not it ever fills.)
 *
 * The unfillable order is a BUY priced far below the market. A buy only matches
 * asks at or below its limit, so a half-price bid crosses nothing.
 *
 * ── What it reports ─────────────────────────────────────────────────────────
 * Two orders go out: first with `grouping: "na"` (the baseline), then with
 * `grouping: {p}`. The baseline matters — if it fails too, the problem is the
 * hand-rolled signing path, not priority support, and the second result says
 * nothing. Only a passing baseline makes the second answer meaningful.
 */

const paramsSchema = z.object({
  // Defaulted, not required: a dashboard select renders its first option before
  // anything is picked, so a required field submits `undefined` while the form
  // looks filled in. Empty means "the only ready account", which is the common case.
  account: z.string().default('').meta({
    displayName: 'Account',
    description: 'The Hyperliquid account whose bound credential signs. Only ready accounts are listed; leave empty to use the sole ready account when there is exactly one.',
  }),
  symbol: z.string().default('BTC/USDC:USDC').meta({
    displayName: 'Market',
    description: 'The market under test. Core perps and HIP-3 markets can answer differently, so probe both.',
    placeholder: 'BTC/USDC:USDC',
  }),
  notionalUsd: z.number().positive().default(15).meta({
    displayName: 'Notional (USD)',
    description: "The venue's minimum order is $10. This order cannot fill by construction, so the size only shapes the rejection message.",
  }),
  priorityBps: z.number().min(0).max(8).default(1).meta({
    displayName: 'Priority rate (bps)',
    description: 'Charged on filled notional only, so nothing is spent while the order cannot fill. 8 is the venue saturation point.',
  }),
  dryRun: z.boolean().default(true).meta({
    displayName: 'Print payload only',
    description: 'Assemble and print the action without sending anything. **Start here.**',
  }),
  liveFill: z.boolean().default(false).meta({
    displayName: 'Real fill (spends money)',
    description: '**Removes the probe safety net**: sends a buy priced to cross and reads the priority fee off the change in staking balance. Incurs real trading fees, slippage and priority fee. Notional is capped at 500.',
  }),
  closeAfter: z.boolean().default(true).meta({
    displayName: 'Close immediately after filling',
    description: 'Only meaningful with a real fill. On by default — this script exists to observe a fee, not to take a position. Turning it off **leaves the position open** for you to handle.',
  }),
})

/** Live mode spends real money; keep the blast radius small regardless of what was typed. */
const LIVE_MAX_NOTIONAL = 500

/** 1 bp = 10000, because the venue reads p / 1e8 as the rate. */
const priorityP = (bps: number) => Math.round(bps * 10_000)

interface Ccxt {
  loadMarkets(): Promise<unknown>
  initializeClient?(): Promise<unknown>
  market(symbol: string): { id: string }
  fetchTicker(symbol: string): Promise<{ last?: number; close?: number }>
  priceToPrecision(symbol: string, price: number): string
  amountToPrecision(symbol: string, amount: number): string
  createOrderRequest(symbol: string, type: string, side: string, amount: number, price: number, params: Record<string, unknown>): Record<string, unknown>
  signL1Action(action: unknown, nonce: number, vaultAddress?: string): unknown
  privatePostExchange(request: unknown): Promise<Record<string, unknown>>
  milliseconds(): number
  walletAddress?: string
}

/** Spot mark price of HYPE — the fee is charged in HYPE, the notional is USD. */
async function hypePrice(): Promise<number | undefined> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    })
    const v = Number((await res.json() as Record<string, string>)['HYPE'])
    return Number.isFinite(v) ? v : undefined
  } catch { return undefined }
}

/** Undelegated stake is where order-priority fees are drawn from. */
async function delegatable(user: string): Promise<number | undefined> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'delegatorSummary', user }),
    })
    const body = await res.json() as { undelegated?: string }
    const v = Number(body.undelegated)
    return Number.isFinite(v) ? v : undefined
  } catch { return undefined }
}

/**
 * Two venue rejections are not failures of the path, and reading them as such
 * throws away the whole answer:
 *
 *  - "could not immediately match" is what an UNFILLABLE IOC is supposed to
 *    get. The action was signed, transmitted and processed — that is the probe
 *    working exactly as designed.
 *  - "Insufficient delegatable balance for priority order" means the venue
 *    PARSED the grouping and got as far as checking the balance. An asset that
 *    did not support priority would have complained about the asset or the
 *    grouping, not asked for money. So this reply PROVES support.
 */
const NO_MATCH = /could not immediately match/i
const NO_PRIORITY_BALANCE = /insufficient delegatable balance/i

/** Flatten the venue's reply into one line, and say plainly when something filled. */
function readReply(res: Record<string, unknown>): { ok: boolean; detail: string; filled: boolean } {
  const response = (res['response'] ?? {}) as Record<string, unknown>
  const data = (response['data'] ?? {}) as Record<string, unknown>
  const statuses = (data['statuses'] ?? []) as Array<Record<string, unknown> | string>
  const first = statuses[0]
  if (first === undefined) {
    return { ok: res['status'] === 'ok', detail: JSON.stringify(res).slice(0, 300), filled: false }
  }
  if (typeof first === 'string') return { ok: true, detail: first, filled: false }
  if (first['error'] !== undefined) return { ok: false, detail: String(first['error']), filled: false }
  if (first['filled'] !== undefined) {
    return { ok: true, detail: `⚠️ FILLED: ${JSON.stringify(first['filled'])}`, filled: true }
  }
  if (first['resting'] !== undefined) {
    return { ok: true, detail: `resting ${JSON.stringify(first['resting'])} (an IOC should never rest)`, filled: false }
  }
  return { ok: true, detail: JSON.stringify(first), filled: false }
}

export const priorityProbeScript: ScriptDefinition = {
  id: 'priority-probe',
  name: 'Priority fee probe',
  description: 'Confirms whether a market accepts an order-priority fee, using an IOC that cannot fill. Nothing fills, so nothing is charged.',
  paramsSchema,

  paramOptions: async (runtime) => {
    const rt = runtime as { listAccounts(): Promise<AccountView[]> }
    const accounts = await rt.listAccounts()
    return {
      account: accounts
        .filter(a => a.type === 'hyperliquid' && a.status === 'ready')
        .map(a => ({ value: a.name, label: `${a.name}（${a.kind ?? 'exchange/perp'}）` })),
    }
  },

  run: async ({ params, runtime }) => {
    const p = paramsSchema.parse(params)
    const rt = runtime as {
      listAccounts(): Promise<AccountView[]>
      adapters: { resolve<T>(kind: string, type: string, credentialName?: string): Promise<T> }
    }

    const out: string[] = []
    const say = (s = '') => out.push(s)
    const hr = () => say('─'.repeat(66))

    const ready = (await rt.listAccounts()).filter(a => a.type === 'hyperliquid' && a.status === 'ready')
    if (ready.length === 0) {
      return { text: 'No ready Hyperliquid account — create one on the Accounts page and bind a credential first.' }
    }
    const account = p.account === ''
      ? (ready.length === 1 ? ready[0]! : undefined)
      : ready.find(a => a.name === p.account)
    if (!account) {
      return p.account === ''
        ? { text: `${ready.length} accounts are ready — pick one explicitly: ${ready.map(a => a.name).join(', ')}` }
        : { text: `No ready Hyperliquid account named "${p.account}" (ready: ${ready.map(a => a.name).join(', ')})` }
    }
    if (!account.credential) return { text: `Account "${account.name}" has no bound credential` }

    const session = await rt.adapters.resolve<{ exchange?: Ccxt }>(
      account.kind ?? 'exchange/perp', account.type ?? 'hyperliquid', account.credential,
    )
    // The signing path needs ccxt's own internals; the adapter holds the instance.
    const ex = (session as unknown as { exchange?: Ccxt }).exchange
    if (!ex) return { text: 'That account resolves to a session without a ccxt exchange — nothing to probe' }

    const missing = (['createOrderRequest', 'signL1Action', 'privatePostExchange', 'milliseconds'] as const)
      .filter(m => typeof (ex as unknown as Record<string, unknown>)[m] !== 'function')
    if (missing.length > 0) {
      return { text: `ccxt is missing internals: ${missing.join(', ')} — this ccxt version cannot take the hand-signed path` }
    }

    await ex.loadMarkets()
    await ex.initializeClient?.()

    const ticker = await ex.fetchTicker(p.symbol)
    const mid = ticker.last ?? ticker.close ?? 0
    if (!(mid > 0)) return { text: `No price available for ${p.symbol}` }

    // Half the market: a buy only matches asks at or below its limit, so this
    // crosses nothing. Nothing fills → no priority fee, no trading fee.
    const price = Number(ex.priceToPrecision(p.symbol, mid * 0.5))
    const amount = Number(ex.amountToPrecision(p.symbol, p.notionalUsd / price))

    say(`Market ${p.symbol}   mid ${mid}`)
    say(`Limit ${price} (~50% of mid, crosses nothing)   size ${amount}   notional ≈ $${(price * amount).toFixed(2)}`)
    say(`Priority ${p.priorityBps} bps → p = ${priorityP(p.priorityBps)} (charged on fills only)`)
    say()

    // ── Live fill ────────────────────────────────────────────────────────────
    // Everything above this point is provably free. From here it is not: the
    // order is priced to cross, so it fills, and the priority fee is actually
    // charged. The position is closed immediately after — the point is to
    // observe the fee, not to hold a view.
    if (p.liveFill && !p.dryRun) {
      const notional = Math.min(p.notionalUsd, LIVE_MAX_NOTIONAL)
      if (notional < p.notionalUsd) say(`⚠️ Notional clamped to the live cap of $${LIVE_MAX_NOTIONAL}`)

      const wallet = ex.walletAddress
      const before = wallet ? await delegatable(wallet) : undefined

      hr()
      say('▶ Real fill: buy, then close immediately')
      say(`  Undelegated stake (before): ${before ?? 'query failed'} HYPE`)

      // Priced to cross. An IOC fills at the book's price, not at this limit —
      // the limit only has to be permissive enough to guarantee a match.
      const buyPx = Number(ex.priceToPrecision(p.symbol, mid * 1.005))
      const qty = Number(ex.amountToPrecision(p.symbol, notional / mid))
      say(`  Buy ${qty} @ limit ${buyPx} (above the ask, certain to cross)  notional ≈ $${(qty * mid).toFixed(2)}`)
      say(`  Expected priority fee ≈ $${(qty * mid * p.priorityBps / 10_000).toFixed(4)}`)

      const buyAction = {
        type: 'order',
        orders: [ex.createOrderRequest(p.symbol, 'limit', 'buy', qty, buyPx, { timeInForce: 'Ioc' })],
        grouping: { p: priorityP(p.priorityBps) },
      }
      let filledQty = 0
      try {
        const nonce = ex.milliseconds()
        const res = await ex.privatePostExchange({ action: buyAction, nonce, signature: ex.signL1Action(buyAction, nonce) })
        const v = readReply(res)
        say(`  → ${v.detail}`)
        const st = (((res['response'] as Record<string, unknown>)?.['data'] as Record<string, unknown>)?.['statuses'] as Array<Record<string, unknown>>)?.[0]
        const f = st?.['filled'] as { totalSz?: string; avgPx?: string } | undefined
        if (f?.totalSz) filledQty = Number(f.totalSz)
      } catch (err) {
        say(`  → ❌ Buy failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`)
      }

      if (filledQty > 0 && !p.closeAfter) {
        say(`  ⏸ Left open (close-after is off) — you now hold a long of ${filledQty}. Handle it yourself.`)
      }

      if (filledQty > 0 && p.closeAfter) {
        // Close with a PLAIN IOC: no priority fee (nothing to race on the way
        // out) and no reduce-only, whose eligibility for priority is ambiguous
        // in the docs and not worth gambling on here.
        const sellPx = Number(ex.priceToPrecision(p.symbol, mid * 0.995))
        say(`  Close ${filledQty} @ limit ${sellPx} (plain IOC, no priority)`)
        const sellAction = {
          type: 'order',
          orders: [ex.createOrderRequest(p.symbol, 'limit', 'sell', filledQty, sellPx, { timeInForce: 'Ioc' })],
          grouping: 'na',
        }
        try {
          const nonce = ex.milliseconds()
          const res = await ex.privatePostExchange({ action: sellAction, nonce, signature: ex.signL1Action(sellAction, nonce) })
          say(`  → ${readReply(res).detail}`)
        } catch (err) {
          say(`  → 🚨 Close FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`)
          say(`  🚨 You now hold a long of ${filledQty} — close it manually on Hyperliquid NOW.`)
        }
      }

      // The venue does not report the priority fee anywhere, so the only way to
      // see it is the balance it came out of.
      await new Promise(r => setTimeout(r, 2000))
      const after = wallet ? await delegatable(wallet) : undefined
      hr()
      say('Result (real fill)')
      say(`  Undelegated stake (after): ${after ?? 'query failed'} HYPE`)
      if (before !== undefined && after !== undefined) {
        const burned = before - after
        say(`  Actually deducted: ${burned.toFixed(8)} HYPE  ← the burned priority fee`)
        if (filledQty > 0 && burned > 0) {
          // The fee is paid in HYPE, the notional is in USD — comparing them
          // directly is off by the HYPE price, which reads as a ~50x discount
          // and makes a correct charge look broken.
          const hypeUsd = await hypePrice()
          if (hypeUsd !== undefined) {
            const burnedUsd = burned * hypeUsd
            say(`  Worth $${burnedUsd.toFixed(6)} (HYPE @ $${hypeUsd})`)
            say(`  Effective rate ≈ ${(burnedUsd / (filledQty * mid) * 10_000).toFixed(4)} bps (requested ${p.priorityBps} bps)`)
          } else {
            say(`  ⚠️ No HYPE price available — cannot express the fee in bps`)
          }
        } else if (burned <= 0) {
          say('  ⚠️ Balance did not move — possibly settlement lag; re-read delegatorSummary shortly.')
        }
      }
      return { text: out.join('\n'), json: { mode: 'liveFill', symbol: p.symbol, mid, notional, filledQty, closed: p.closeAfter, before, after, priorityBps: p.priorityBps } }
    }

    const attempt = async (label: string, grouping: unknown) => {
      hr()
      say(`▶ ${label}`)
      const orderObj = ex.createOrderRequest(p.symbol, 'limit', 'buy', amount, price, { timeInForce: 'Ioc' })
      const action = { type: 'order', orders: [orderObj], grouping }
      say(`  grouping = ${JSON.stringify(grouping)}`)

      if (p.dryRun) {
        say('  [print only] action:')
        say(JSON.stringify(action, null, 2).split('\n').map(l => '    ' + l).join('\n'))
        return { ok: true, detail: '(dry run)', filled: false }
      }

      try {
        const nonce = ex.milliseconds()
        const signature = ex.signL1Action(action, nonce)
        const res = await ex.privatePostExchange({ action, nonce, signature })
        const v = readReply(res)
        say(`  → ${v.ok ? '✅ accepted' : '❌ rejected'}: ${v.detail}`)
        return v
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        say(`  → ❌ threw: ${msg.slice(0, 400)}`)
        return { ok: false, detail: msg, filled: false }
      }
    }

    // Baseline first: it isolates "the venue rejects priority" from "our
    // hand-rolled signing is wrong". Without it the second result is unreadable.
    const base = await attempt('Baseline: grouping = "na" (no priority)', 'na')
    const prio = await attempt(`Priority: grouping = { p: ${priorityP(p.priorityBps)} }`, { p: priorityP(p.priorityBps) })

    hr()
    say('Result')
    // An unfillable IOC that is told it could not match HAS proven the path.
    const pathWorks = base.ok || NO_MATCH.test(base.detail)
    const prioSupported = prio.ok || NO_MATCH.test(prio.detail) || NO_PRIORITY_BALANCE.test(prio.detail)
    const needsBalance = NO_PRIORITY_BALANCE.test(prio.detail)

    if (p.dryRun) {
      say('  [print only] Nothing was sent. Check the action above, then turn print-only off and run again.')
    } else if (!pathWorks) {
      say('  ⚠️ The baseline itself failed — this run cannot answer the question. Fix the baseline first.')
      say(`     Baseline error: ${base.detail}`)
    } else if (prioSupported) {
      say(`  ✅ ${p.symbol} supports order-priority fees. The hand-signed path works and the adapter can rely on it.`)
      if (needsBalance) {
        say('')
        say('  ⚠️ But the undelegated stake is short, so a real order would have its priority rejected.')
        say('     The fee is drawn from the undelegated STAKING balance, not spot. To top it up:')
        say('       1. buy HYPE on spot  →  2. cDeposit into staking  →  3. leave it undelegated')
        say('     Note: staking → spot takes a 7-day unstaking queue, so do not overfund it.')
        say('     Read it from POST /info {"type":"delegatorSummary","user":"0x…"} → undelegated')
      }
    } else {
      say(`  ❌ ${p.symbol} rejected the priority order, and not for want of balance.`)
      say(`     Verbatim error: ${prio.detail}`)
      say('     If it names the asset or the grouping, this market genuinely has no priority support.')
    }

    if (base.filled || prio.filled) {
      hr()
      say('🚨 An order FILLED — that should not happen. Check Hyperliquid and flatten the position now.')
    }

    return {
      text: out.join('\n'),
      json: {
        symbol: p.symbol, mid, price, amount,
        priorityBps: p.priorityBps, p: priorityP(p.priorityBps),
        dryRun: p.dryRun,
        baseline: base, priority: prio,
      },
    }
  },
}
