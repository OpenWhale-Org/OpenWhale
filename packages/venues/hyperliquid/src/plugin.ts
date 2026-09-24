import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import { priorityProbeScript } from './scripts/priorityProbe.js'
import type { RawCredentialData } from '@openwhaleorg/core'
import { HyperliquidAdapter } from './adapter.js'
import { UserTradesMonitor } from './monitor.js'

/**
 * The fields a Hyperliquid credential holds, exported so a plugin that adds
 * to them extends this rather than retyping it — three fields is few enough
 * to copy and exactly few enough for a copy to drift unnoticed.
 */
export const hyperliquidCredentialSchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).meta({ displayName: 'Wallet Address', placeholder: '0x...' }),
  privateKey: z.string().optional().meta({ displayName: 'Private Key', password: true, description: 'Leave empty for read-only' }),
  testnet: z.boolean().default(false).meta({ displayName: 'Testnet' }),
})

/**
 * A trading session from stored credential data.
 *
 * `builder` and `builderFeeTenthsBp` are read if the data carries them and
 * left to their defaults otherwise. This plugin's own schema declares neither
 * — routing the fee somewhere else is policy, and policy belongs to whoever
 * has a reason. A plugin that declares those fields and registers its own
 * cell gets the behaviour for free by calling this.
 */
export const buildHyperliquidAdapter = (data: RawCredentialData) => new HyperliquidAdapter({
  walletAddress: data['walletAddress'] as string,
  ...(data['privateKey'] ? { privateKey: data['privateKey'] as string } : {}),
  testnet: (data['testnet'] as boolean | undefined) ?? false,
  ...(data['builderAddress'] ? { builder: data['builderAddress'] as string } : {}),
  ...(data['builderFeeBp'] !== undefined && data['builderFeeBp'] !== null && data['builderFeeBp'] !== ''
    ? { builderFeeTenthsBp: Math.round(Number(data['builderFeeBp']) * 10) }
    : {}),
})

/** Connectivity check shared with any plugin that extends this credential. */
export const testHyperliquidCredential = async (data: RawCredentialData): Promise<void> => {
  await buildHyperliquidAdapter(data).fetchBalance()
}

const build = buildHyperliquidAdapter

/**
 * Hyperliquid venue plugin — a pure manifest.
 *
 *   - credential type 'hyperliquid': schema-driven form, connectivity test
 *   - adapter cells for 'exchange/perp' and 'exchange/spot' (one wallet, both
 *     kinds; the keyless perp form is a public ccxt adapter — always mainnet)
 *   - monitor 'hyperliquid/user-trades' — watches ANY address's fills
 *     (credential-less, so a default instance auto-activates)
 *
 * Strategies live elsewhere: this package is venue capability only. The
 * copy-trading strategy that consumes the fills feed ships in
 * @openwhaleorg/examples.
 *
 * Requires the exchange domain plugin (kind 'exchange/perp' vocabulary).
 */
export const hyperliquidPlugin = definePlugin({
  name: 'hyperliquid',
  version: '1.0.0',

  scripts: [priorityProbeScript],

  adapters: [
    {
      kind: 'exchange/perp', type: 'hyperliquid',
      // Keyless form is the HIP-3-aware public adapter: fetchFundingRates
      // aggregates every builder dex, not just the main universe.
      create: (data?) => data ? build(data) : new HyperliquidAdapter(),
    },
    {
      // HL spot shares the same API surface — one wallet, both kinds.
      // No keyless form: public spot data has no consumer yet, and the
      // implementation is the caller-validates side of the contract.
      kind: 'exchange/spot', type: 'hyperliquid',
      create: (data?) => {
        if (!data) throw new Error('hyperliquid exchange/spot has no keyless form — bind a credential')
        return build(data)
      },
    },
  ],

  credentialTypes: [
    {
      type: 'hyperliquid',
      displayName: 'Hyperliquid',
      logo: '/brands/hyperliquid.png',
      icon: '💧',
      description: 'Perp DEX. Wallet address alone is read-only; add a private key to trade.',
      documentationUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs',
      schema: hyperliquidCredentialSchema,
      test: testHyperliquidCredential,
    },
  ],

  monitors: [UserTradesMonitor],
})

export default hyperliquidPlugin
