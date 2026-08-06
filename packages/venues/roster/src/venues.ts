import { z } from 'zod'
import type { CcxtVenueSpec } from './defineCcxtVenue.js'

/**
 * The venue roster. Every field here was verified against the installed ccxt
 * build (exchange id, required credentials, which market types it serves,
 * whether it has a sandbox) — see __tests__/venues.test.ts, which re-checks
 * the ids and credential shapes on every run.
 *
 * Modelling rule: one entry = one API key. Kraken's spot and futures products
 * need DIFFERENT keys behind DIFFERENT ccxt ids, so they are two venues; OKX
 * and Bitget serve both kinds off one key, so they are one venue with two
 * cells.
 */
export const VENUE_SPECS: CcxtVenueSpec[] = [
  {
    name: 'bybit',
    displayName: 'Bybit',
    documentationUrl: 'https://bybit-exchange.github.io/docs/v5/intro',
    markets: { 'exchange/perp': 'bybit', 'exchange/spot': 'bybit' },
    credentialStyle: 'key-secret',
    testnet: true,
  },
  {
    name: 'okx',
    displayName: 'OKX',
    documentationUrl: 'https://www.okx.com/docs-v5/en/',
    markets: { 'exchange/perp': 'okx', 'exchange/spot': 'okx' },
    // OKX issues a passphrase alongside the key pair — all three are required
    credentialStyle: 'key-secret-passphrase',
    testnet: true,
    // OKX's default ccxt catalogue loads spot, futures, swaps and options in
    // parallel. Each OpenWhale adapter serves one kind, so loading unrelated
    // catalogues only increases cold-start latency and timeout exposure.
    ccxtOptions: (_data, kind) => ({
      timeout: 30_000,
      options: { fetchMarkets: { types: [kind === 'exchange/perp' ? 'swap' : 'spot'] } },
    }),
  },
  {
    name: 'bitget',
    displayName: 'Bitget',
    documentationUrl: 'https://www.bitget.com/api-doc/common/intro',
    markets: { 'exchange/perp': 'bitget', 'exchange/spot': 'bitget' },
    credentialStyle: 'key-secret-passphrase',
    // No sandbox in ccxt's bitget build — every order is live
  },
  {
    name: 'gate',
    displayName: 'Gate.io',
    documentationUrl: 'https://www.gate.com/docs/developers/apiv4/',
    markets: { 'exchange/perp': 'gate', 'exchange/spot': 'gate' },
    credentialStyle: 'key-secret',
    testnet: true,
  },
  {
    name: 'kraken',
    displayName: 'Kraken (Spot)',
    documentationUrl: 'https://docs.kraken.com/rest/',
    // Spot only: Kraken's derivatives live on a separate platform + key
    markets: { 'exchange/spot': 'kraken' },
    credentialStyle: 'key-secret',
  },
  {
    name: 'kraken-futures',
    displayName: 'Kraken Futures',
    documentationUrl: 'https://docs.futures.kraken.com/',
    markets: { 'exchange/perp': 'krakenfutures' },
    credentialStyle: 'key-secret',
    testnet: true,
  },
  {
    name: 'upbit',
    displayName: 'Upbit',
    documentationUrl: 'https://docs.upbit.com/kr/reference/',
    // Korea's largest spot venue — no derivatives, and quotes are mostly KRW
    markets: { 'exchange/spot': 'upbit' },
    credentialStyle: 'key-secret',
  },
  {
    name: 'lighter',
    displayName: 'Lighter',
    documentationUrl: 'https://apidocs.lighter.xyz/',
    // zk-rollup orderbook DEX: perps only, signed with a rollup key
    markets: { 'exchange/perp': 'lighter' },
    credentialStyle: 'private-key',
    testnet: true,
    extraFields: {
      accountIndex: z.number().int().min(0).meta({
        displayName: 'Account Index',
        description: 'Your Lighter account index (shown in the app / returned by the accounts endpoint)',
      }),
      apiKeyIndex: z.number().int().min(0).default(0).meta({
        displayName: 'API Key Index',
        description: 'Slot of the registered API key for this account (0 unless you registered several)',
      }),
    },
    // Lighter carries the account/key identity in ccxt options, not credentials
    ccxtOptions: (data) => ({
      accountIndex: Number(data['accountIndex'] ?? 0),
      apiKeyIndex: Number(data['apiKeyIndex'] ?? 0),
    }),
  },
  {
    name: 'mexc',
    displayName: 'MEXC',
    documentationUrl: 'https://mexcdevelop.github.io/apidocs/spot_v3_en/',
    markets: { 'exchange/perp': 'mexc', 'exchange/spot': 'mexc' },
    credentialStyle: 'key-secret',
  },
  {
    name: 'kucoin',
    displayName: 'KuCoin (Spot)',
    documentationUrl: 'https://www.kucoin.com/docs/beginners/introduction',
    markets: { 'exchange/spot': 'kucoin' },
    credentialStyle: 'key-secret-passphrase',
  },
  {
    name: 'kucoin-futures',
    displayName: 'KuCoin Futures',
    documentationUrl: 'https://www.kucoin.com/docs/beginners/introduction',
    markets: { 'exchange/perp': 'kucoinfutures' },
    credentialStyle: 'key-secret-passphrase',
    testnet: true,
  },
  {
    name: 'bingx',
    displayName: 'BingX',
    documentationUrl: 'https://bingx-api.github.io/docs/',
    markets: { 'exchange/perp': 'bingx', 'exchange/spot': 'bingx' },
    credentialStyle: 'key-secret',
  },
]
