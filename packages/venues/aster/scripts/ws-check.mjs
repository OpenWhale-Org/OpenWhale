/**
 * Is Aster's websocket actually feeding us?
 *
 * Run after any ccxt upgrade:  node packages/venues/aster/scripts/ws-check.mjs
 *
 * It watches one symbol twice for the same few seconds — once through a plain
 * ccxt adapter, once through ours — and counts what arrives. The plain column
 * is what upstream gives you today; ours is what the engine sees. If they ever
 * match, the alias in adapter.ts has become unnecessary (or has stopped
 * working, which the numbers will make obvious either way).
 *
 * Public market data only: no credentials, no orders.
 */
import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { AsterPublicAdapter } from '../dist/adapter.js'

const SYMBOL = process.argv[2] ?? 'SNXX/USDT:USDT'
const SECONDS = Number(process.argv[3] ?? 12)

async function count(label, adapter, watch) {
  const ctl = new AbortController()
  let n = 0, first = null
  const t0 = Date.now()
  const stop = setTimeout(() => ctl.abort(), SECONDS * 1000)
  try {
    await watch(adapter, () => { n++; first ??= Date.now() - t0 }, ctl.signal)
  } catch (err) {
    console.log(`${label.padEnd(30)} threw: ${err.message}`)
  }
  clearTimeout(stop)
  return { n, first }
}

const cases = [
  ['order book', (a, cb, s) => a.watchOrderBook(SYMBOL, cb, 20, s)],
  ['ticker', (a, cb, s) => a.watchTicker(SYMBOL, cb, s)],
]

console.log(`${SYMBOL} · ${SECONDS}s per run\n`)
console.log(`${''.padEnd(12)}${'plain ccxt'.padStart(14)}${'this adapter'.padStart(16)}`)
for (const [what, watch] of cases) {
  const plain = await count(`plain ${what}`, new CcxtAdapter({ exchangeId: 'aster' }), watch)
  const ours = await count(`ours ${what}`, new AsterPublicAdapter(), watch)
  const fmt = (r) => `${r.n} (${r.first ?? '—'}ms)`
  console.log(`${what.padEnd(12)}${fmt(plain).padStart(14)}${fmt(ours).padStart(16)}`)
}
process.exit(0)
