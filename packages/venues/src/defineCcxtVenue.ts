import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'
import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import type { CcxtAdapterOptions } from '@openwhaleorg/ccxt-adapter'

/**
 * A ccxt venue is a plugin with no behaviour of its own: one credential type
 * (the key) plus one adapter cell per kind it serves (the matrix squares).
 * Everything else — market data, accounts, order flow — already lives in the
 * exchange domain package and starts working the moment the cells register.
 *
 * So a venue is DATA. Describe it in `venues.ts`; `defineCcxtVenue` lowers the
 * description into the same manifest a hand-written plugin would produce.
 * Adding an exchange is one entry, not a new package.
 */

/** How the venue authenticates. Drives the credential form. */
export type CredentialStyle =
  /** Classic REST key pair. */
  | 'key-secret'
  /** Key pair plus a user-chosen passphrase (OKX, Bitget, KuCoin). */
  | 'key-secret-passphrase'
  /** Wallet/rollup signing key (Lighter, dYdX-style venues). */
  | 'private-key'

export interface CcxtVenueSpec {
  /** Plugin name AND credential type — the venue's identity everywhere. */
  name: string
  displayName: string
  documentationUrl: string
  /**
   * kind → ccxt exchange id. A venue whose products sit behind separate ccxt
   * ids AND separate API keys is modelled as two venues instead — see
   * kraken vs kraken-futures.
   */
  markets: Partial<Record<'exchange/perp' | 'exchange/spot', string>>
  credentialStyle: CredentialStyle
  /** Venue has a sandbox → the credential form gets a Testnet toggle. */
  testnet?: boolean
  /** Extra credential fields (venue-specific identifiers). */
  extraFields?: z.ZodRawShape
  /** Map credential data onto raw ccxt constructor options. */
  ccxtOptions?: (data: RawCredentialData) => Record<string, unknown>
}

const field = {
  apiKey: z.string().min(1).meta({ displayName: 'API Key' }),
  secret: z.string().min(1).meta({ displayName: 'API Secret', password: true }),
  passphrase: z.string().min(1).meta({ displayName: 'Passphrase', password: true, description: 'The passphrase chosen when the API key was created' }),
  privateKey: z.string().min(1).meta({ displayName: 'Private Key', password: true }),
  testnet: z.boolean().default(false).meta({ displayName: 'Testnet', description: "Use the venue's sandbox instead of production" }),
}

function credentialShape(spec: CcxtVenueSpec): z.ZodRawShape {
  const base: z.ZodRawShape =
    spec.credentialStyle === 'private-key' ? { privateKey: field.privateKey }
      : spec.credentialStyle === 'key-secret-passphrase' ? { apiKey: field.apiKey, secret: field.secret, password: field.passphrase }
        : { apiKey: field.apiKey, secret: field.secret }
  return {
    ...base,
    ...(spec.extraFields ?? {}),
    ...(spec.testnet ? { testnet: field.testnet } : {}),
  }
}

/** Credential data → adapter options for one of the venue's ccxt ids. */
function toOptions(spec: CcxtVenueSpec, exchangeId: string, data: RawCredentialData): CcxtAdapterOptions {
  const extra = spec.ccxtOptions?.(data)
  return {
    exchangeId,
    ...(data['apiKey'] ? { apiKey: String(data['apiKey']) } : {}),
    ...(data['secret'] ? { secret: String(data['secret']) } : {}),
    ...(data['password'] ? { password: String(data['password']) } : {}),
    ...(data['privateKey'] ? { privateKey: String(data['privateKey']) } : {}),
    ...(data['walletAddress'] ? { walletAddress: String(data['walletAddress']) } : {}),
    ...(spec.testnet ? { testnet: Boolean(data['testnet']) } : {}),
    ...(extra && Object.keys(extra).length > 0 ? { ccxtOptions: extra } : {}),
  }
}

/** The kinds a venue serves, in matrix order. */
export function venueKinds(spec: CcxtVenueSpec): Array<'exchange/perp' | 'exchange/spot'> {
  return Object.keys(spec.markets) as Array<'exchange/perp' | 'exchange/spot'>
}

/**
 * Build the venue's adapter for a kind. Exported so tests (and callers that
 * already hold credential data) can construct one without the registry.
 */
export function buildVenueAdapter(
  spec: CcxtVenueSpec,
  kind: 'exchange/perp' | 'exchange/spot',
  data?: RawCredentialData,
): CcxtAdapter {
  const exchangeId = spec.markets[kind]
  if (!exchangeId) throw new Error(`${spec.displayName} does not serve kind "${kind}"`)
  // Keyless form = the public adapter: market data with no credential bound.
  return new CcxtAdapter(data ? toOptions(spec, exchangeId, data) : { exchangeId })
}

export function defineCcxtVenue(spec: CcxtVenueSpec) {
  const kinds = venueKinds(spec)
  if (kinds.length === 0) throw new Error(`Venue "${spec.name}" declares no markets`)

  return definePlugin({
    name: spec.name,
    version: '1.0.0',

    adapters: kinds.map(kind => ({
      kind,
      type: spec.name,
      create: (data?: RawCredentialData) => buildVenueAdapter(spec, kind, data),
    })),

    credentialTypes: [{
      type: spec.name,
      displayName: spec.displayName,
      documentationUrl: spec.documentationUrl,
      schema: z.object(credentialShape(spec)),
      // Balance is the cheapest call that proves the key is accepted AND
      // carries read permission; it runs against the venue's primary kind.
      test: async (data: RawCredentialData) => { await buildVenueAdapter(spec, kinds[0]!, data).fetchBalance() },
    }],
  })
}
