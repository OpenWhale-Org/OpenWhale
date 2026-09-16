import { createHmac, createPrivateKey, sign } from 'node:crypto'
import type { RawCredentialData } from '@openwhaleorg/core'

/**
 * Binance API keys come in two signing schemes, and a credential carries one.
 *
 * - HMAC: the classic key. The secret is a shared string; signatures are
 *   hex HMAC-SHA256 of the query.
 * - Ed25519: an asymmetric key. The operator generates the pair, uploads the
 *   PUBLIC half to Binance and keeps the PRIVATE half here, as a PKCS#8 PEM.
 *   Signatures are base64 Ed25519 of the query. Binance recommends it for
 *   trading keys, and it is the only kind its WebSocket API accepts for
 *   `session.logon`.
 *
 * ccxt already signs with Ed25519 whenever the secret it is handed is a PEM
 * private key, so the adapters only need the right string; code that signs
 * requests itself goes through `signBinanceQuery`.
 */

const PEM_HEADER = '-----BEGIN PRIVATE KEY-----'
const PEM_FOOTER = '-----END PRIVATE KEY-----'

/**
 * A pasted Ed25519 private key as a clean PKCS#8 PEM.
 *
 * Tolerates what copy-paste does to a PEM — CRLF, indentation, the whole thing
 * on one line — by keeping only the base64 body and re-wrapping it. The
 * result stays under 120 characters, which is what ccxt looks at to tell an
 * Ed25519 PEM from an RSA one.
 */
export function normalizeEd25519Pem(raw: string): string {
  const text = raw.trim()
  if (/BEGIN (RSA )?PUBLIC KEY/.test(text)) {
    throw new Error('This is the PUBLIC key. Upload it to Binance; paste the PRIVATE key (BEGIN PRIVATE KEY) here.')
  }
  if (!text.includes(PEM_HEADER) || !text.includes(PEM_FOOTER)) {
    throw new Error('Ed25519 private key must be a PEM starting with "-----BEGIN PRIVATE KEY-----".')
  }
  const body = text.slice(text.indexOf(PEM_HEADER) + PEM_HEADER.length, text.indexOf(PEM_FOOTER)).replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) ?? []
  const pem = `${PEM_HEADER}\n${lines.join('\n')}\n${PEM_FOOTER}\n`
  let keyType: string | undefined
  try {
    keyType = createPrivateKey(pem).asymmetricKeyType
  } catch (err) {
    throw new Error(`Ed25519 private key could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (keyType !== 'ed25519') {
    throw new Error(`Expected an Ed25519 private key, got ${keyType ?? 'an unknown key type'}. RSA keys are not supported here.`)
  }
  return pem
}

/**
 * The string a credential signs with: the HMAC secret, or the normalized
 * Ed25519 PEM. Exactly one of the two must be set.
 */
export function binanceSigningSecret(data: RawCredentialData): string {
  const secret = typeof data['secret'] === 'string' ? data['secret'].trim() : ''
  const privateKey = typeof data['privateKey'] === 'string' ? data['privateKey'].trim() : ''
  if (secret && privateKey) {
    throw new Error('Set either the API Secret (HMAC key) or the Ed25519 private key, not both.')
  }
  if (privateKey) return normalizeEd25519Pem(privateKey)
  if (secret) return secret
  throw new Error('Binance credential needs an API Secret (HMAC key) or an Ed25519 private key.')
}

/** Which scheme a signing secret belongs to. */
export function binanceKeyKind(secret: string): 'hmac' | 'ed25519' {
  return secret.includes(PEM_HEADER) ? 'ed25519' : 'hmac'
}

/**
 * The `signature` value for a query string, already URL-encoded where the
 * scheme needs it: hex for HMAC, percent-encoded base64 for Ed25519.
 */
export function signBinanceQuery(query: string, secret: string): string {
  if (binanceKeyKind(secret) === 'ed25519') {
    return encodeURIComponent(sign(null, Buffer.from(query), createPrivateKey(secret)).toString('base64'))
  }
  return createHmac('sha256', secret).update(query).digest('hex')
}
