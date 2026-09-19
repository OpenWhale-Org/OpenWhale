import { createHash } from 'node:crypto'
import { RetryableAdapterError, TerminalAdapterError } from '@openwhaleorg/core'
import type {
  WalletBalance,
  WalletCommand,
  WalletExecution,
  WalletExecutionOutcome,
  WalletIdentity,
  WalletOrder,
  WalletPolicy,
  WalletPosition,
  WalletScope,
  WhaleDanceWalletSession,
} from './types.js'

const WALLET_PATH = '/external/v1/wallet'
const WRITE_ATTEMPTS = 2
const DEFAULT_TIMEOUT_MS = 15_000

export interface WhaleDanceWalletClientOptions {
  apiBaseUrl: string
  walletCredential: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

interface JsonResponse {
  status: number
  ok: boolean
  headers: Headers
  body: unknown
}

/**
 * Deep client module for WhaleDance's delegated wallet interface.
 *
 * Callers express wallet commands. This module owns transport details,
 * policy preflight, stable idempotency keys, safe same-key retries, response
 * normalization and the distinction between confirmed failure and ambiguity.
 */
export class WhaleDanceWalletClient implements WhaleDanceWalletSession {
  private readonly baseUrl: string
  private readonly credential: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
  private identityPromise: Promise<WalletIdentity> | undefined

  constructor(options: WhaleDanceWalletClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.apiBaseUrl)
    if (!options.walletCredential.startsWith('wdc_')) {
      throw new Error('WhaleDance Wallet Credential must start with "wdc_"')
    }
    this.credential = options.walletCredential
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (!this.fetchImpl) throw new Error('A fetch implementation is required')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  }

  getIdentity(): Promise<WalletIdentity> {
    if (!this.identityPromise) {
      this.identityPromise = this.read('/account').then(parseIdentity).catch((err) => {
        this.identityPromise = undefined
        throw err
      })
    }
    return this.identityPromise
  }

  async getBalance(): Promise<WalletBalance> {
    const body = record(await this.read('/balance'), 'balance')
    return {
      accountValue: decimal(body['accountValue'], 'accountValue'),
      withdrawable: decimal(body['withdrawable'], 'withdrawable'),
      totalMarginUsed: decimal(body['totalMarginUsed'], 'totalMarginUsed'),
      spotUsdc: decimal(body['spotUsdc'], 'spotUsdc'),
      loading: body['loading'] === true,
    }
  }

  async getPositions(): Promise<WalletPosition[]> {
    const body = record(await this.read('/positions'), 'positions')
    const rows = Array.isArray(body['assetPositions']) ? body['assetPositions'] : []
    return rows.map((entry, index) => {
      const outer = record(entry, `assetPositions[${index}]`)
      const position = record(outer['position'], `assetPositions[${index}].position`)
      const leverage = record(position['leverage'], `assetPositions[${index}].position.leverage`)
      const size = decimal(position['szi'], 'szi')
      const signedSize = Number(size)
      return {
        coin: text(position['coin'], 'coin'),
        size,
        entryPrice: decimal(position['entryPx'], 'entryPx'),
        positionValue: decimal(position['positionValue'], 'positionValue'),
        side: signedSize > 0 ? 'long' : signedSize < 0 ? 'short' : 'flat',
        leverage: finiteNumber(leverage['value'], 'leverage.value'),
        marginMode: leverage['type'] === 'cross' ? 'cross' : 'isolated',
        unrealizedPnl: decimal(position['unrealizedPnl'], 'unrealizedPnl'),
        ...(position['liquidationPx'] !== undefined && position['liquidationPx'] !== null
          ? { liquidationPrice: decimal(position['liquidationPx'], 'liquidationPx') }
          : {}),
        raw: entry,
      }
    })
  }

  async getOrders(): Promise<WalletOrder[]> {
    const body = await this.read('/orders')
    if (!Array.isArray(body)) throw new RetryableAdapterError('WhaleDance orders response is not an array')
    return body.map((entry, index) => {
      const order = record(entry, `orders[${index}]`)
      return {
        coin: text(order['coin'], 'coin'),
        side: orderSide(order['side']),
        price: decimal(order['limitPx'], 'limitPx'),
        size: decimal(order['sz'], 'sz'),
        originalSize: decimal(order['origSz'], 'origSz'),
        orderId: identifier(order['oid'], 'oid'),
        timestamp: finiteNumber(order['timestamp'], 'timestamp'),
        reduceOnly: order['reduceOnly'] === true,
        orderType: typeof order['orderType'] === 'string' ? order['orderType'] : 'Unknown',
        raw: entry,
      }
    })
  }

  async execute(command: WalletCommand, commandId: string): Promise<WalletExecutionOutcome> {
    const identity = await this.getIdentity()
    assertAllowed(command, identity)

    const idempotencyKey = commandKey(commandId)
    const { path, body } = commandRequest(command)

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      let response: JsonResponse
      try {
        response = await this.request(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        if (attempt + 1 < WRITE_ATTEMPTS) {
          await delay(250)
          continue
        }
        return { status: 'unknown', idempotencyKey, error: safeMessage(err) }
      }

      if (response.ok) return parseExecutionOutcome(response.body, idempotencyKey)

      const error = errorBody(response.body)
      if (response.status === 409 && error.executionId) {
        const recovered = await this.recoverExecution(error.executionId)
        return { ...recovered, idempotencyKey }
      }
      if (response.status === 503) {
        return {
          ...(error.executionId ? { executionId: error.executionId } : {}),
          status: 'unknown',
          idempotencyKey,
          error: error.message ?? 'WhaleDance could not confirm whether the command completed',
        }
      }
      if (response.status === 429) {
        if (attempt + 1 < WRITE_ATTEMPTS) {
          await delay(retryDelay(response.headers))
          continue
        }
        throw new RetryableAdapterError(error.message ?? 'WhaleDance write rate limit exceeded')
      }
      if (response.status >= 500) {
        if (attempt + 1 < WRITE_ATTEMPTS) {
          await delay(250)
          continue
        }
        return { status: 'unknown', idempotencyKey, error: error.message ?? `WhaleDance returned HTTP ${response.status}` }
      }
      throw new TerminalAdapterError(error.message ?? `WhaleDance rejected the command (HTTP ${response.status})`)
    }

    return { status: 'unknown', idempotencyKey, error: 'WhaleDance command outcome is unknown' }
  }

  async getExecution(executionId: string): Promise<WalletExecution> {
    return parseExecution(await this.read(`/executions/${encodeURIComponent(executionId)}`))
  }

  async close(): Promise<void> {}

  private async recoverExecution(executionId: string): Promise<Omit<WalletExecutionOutcome, 'idempotencyKey'>> {
    try {
      const execution = await this.getExecution(executionId)
      return {
        executionId,
        status: execution.status,
        ...(execution.result !== undefined ? { result: execution.result } : {}),
        ...(execution.error !== undefined ? { error: errorText(execution.error) } : {}),
      }
    } catch (err) {
      return { executionId, status: 'unknown', error: safeMessage(err) }
    }
  }

  private async read(path: string): Promise<unknown> {
    let response: JsonResponse
    try {
      response = await this.request(path, { method: 'GET' })
    } catch (err) {
      throw new RetryableAdapterError(`WhaleDance request failed: ${safeMessage(err)}`, { cause: err })
    }
    if (response.ok) return response.body
    const error = errorBody(response.body)
    const message = error.message ?? `WhaleDance returned HTTP ${response.status}`
    if (response.status === 401 || response.status === 403 || response.status === 400 || response.status === 404) {
      throw new TerminalAdapterError(message)
    }
    throw new RetryableAdapterError(message)
  }

  private async request(path: string, init: RequestInit): Promise<JsonResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}${WALLET_PATH}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.credential}`,
        Accept: 'application/json',
        ...init.headers,
      },
    })
    const raw = await response.text()
    let body: unknown = undefined
    if (raw) {
      try { body = JSON.parse(raw) as unknown }
      catch { body = { message: `WhaleDance returned a non-JSON response (HTTP ${response.status})` } }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, body }
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new Error('WhaleDance API URL must use HTTPS (HTTP is allowed only for localhost)')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WhaleDance API URL must be an origin without a path, query, or fragment')
  }
  return url.toString().replace(/\/$/, '')
}

function commandKey(commandId: string): string {
  return `ow_${createHash('sha256').update(commandId).digest('hex')}`
}

function commandRequest(command: WalletCommand): { path: string; body: Record<string, unknown> } {
  switch (command.action) {
  case 'openMarket': return { path: '/orders/market', body: withoutUndefined(command, 'action') }
  case 'openLimit': return { path: '/orders/limit', body: withoutUndefined(command, 'action') }
  case 'closePosition': return { path: '/positions/close', body: withoutUndefined(command, 'action') }
  case 'setLeverage': return { path: '/positions/leverage', body: withoutUndefined(command, 'action') }
  case 'adjustIsolatedMargin': return { path: '/positions/isolated-margin', body: withoutUndefined(command, 'action') }
  case 'setTpSl': return { path: '/positions/tpsl', body: withoutUndefined(command, 'action') }
  case 'cancelOrders': return { path: '/orders/cancel', body: { cancels: command.cancels } }
  }
}

function withoutUndefined(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== omit && item !== undefined))
}

function requiredScope(command: WalletCommand): WalletScope {
  switch (command.action) {
  case 'openMarket':
  case 'openLimit': return 'orders:write'
  case 'cancelOrders': return 'orders:cancel'
  case 'closePosition': return 'positions:close'
  case 'setLeverage':
  case 'adjustIsolatedMargin':
  case 'setTpSl': return 'positions:manage'
  }
}

function commandCoins(command: WalletCommand): string[] {
  return command.action === 'cancelOrders' ? command.cancels.map(c => c.coin) : [command.coin]
}

function assertAllowed(command: WalletCommand, identity: WalletIdentity): void {
  const scope = requiredScope(command)
  if (!identity.scopes.includes(scope)) throw new TerminalAdapterError(`WhaleDance credential lacks scope "${scope}"`)

  const allowed = identity.policy.allowedAssets
  if (allowed.length > 0) {
    const denied = commandCoins(command).find(coin => !allowed.includes(coin))
    if (denied) throw new TerminalAdapterError(`Asset "${denied}" is not allowed by the WhaleDance credential policy`)
  }

  if ('leverage' in command && command.leverage > identity.policy.maxLeverage) {
    throw new TerminalAdapterError(`Leverage ${command.leverage} exceeds the credential maximum ${identity.policy.maxLeverage}`)
  }
  if (command.action === 'openMarket' || command.action === 'openLimit') {
    const notional = command.marginUsd * command.leverage
    if (notional > identity.policy.maxOrderNotionalUsd) {
      throw new TerminalAdapterError(`Order notional ${notional} exceeds the credential maximum ${identity.policy.maxOrderNotionalUsd}`)
    }
  }
  if ('slippageBps' in command && command.slippageBps !== undefined && command.slippageBps > identity.policy.maxSlippageBps) {
    throw new TerminalAdapterError(`Slippage ${command.slippageBps} bps exceeds the credential maximum ${identity.policy.maxSlippageBps} bps`)
  }
  if (command.action === 'adjustIsolatedMargin' && Math.abs(command.deltaUsd) > identity.policy.maxOrderNotionalUsd) {
    throw new TerminalAdapterError(`Margin adjustment exceeds the credential maximum ${identity.policy.maxOrderNotionalUsd}`)
  }
}

function parseIdentity(value: unknown): WalletIdentity {
  const body = record(value, 'account')
  const policy = record(body['policy'], 'account.policy')
  const scopes = Array.isArray(body['scopes']) ? body['scopes'].filter(isWalletScope) : []
  return {
    id: text(body['id'], 'id'),
    venue: text(body['venue'], 'venue'),
    address: text(body['address'], 'address'),
    scopes,
    policy: parsePolicy(policy),
  }
}

function parsePolicy(policy: Record<string, unknown>): WalletPolicy {
  return {
    allowedAssets: Array.isArray(policy['allowedAssets']) ? policy['allowedAssets'].filter((v): v is string => typeof v === 'string') : [],
    maxLeverage: finiteNumber(policy['maxLeverage'], 'maxLeverage'),
    maxOrderNotionalUsd: finiteNumber(policy['maxOrderNotionalUsd'], 'maxOrderNotionalUsd'),
    maxDailyNotionalUsd: finiteNumber(policy['maxDailyNotionalUsd'], 'maxDailyNotionalUsd'),
    maxSlippageBps: finiteNumber(policy['maxSlippageBps'], 'maxSlippageBps'),
  }
}

function parseExecutionOutcome(value: unknown, idempotencyKey: string): WalletExecutionOutcome {
  const body = record(value, 'execution result')
  const status = executionStatus(body['status'])
  return {
    executionId: identifier(body['executionId'], 'executionId'),
    status,
    idempotencyKey,
    ...(typeof body['replayed'] === 'boolean' ? { replayed: body['replayed'] } : {}),
    ...(body['result'] !== undefined ? { result: body['result'] } : {}),
    ...(body['error'] !== undefined && body['error'] !== null ? { error: errorText(body['error']) } : {}),
  }
}

function parseExecution(value: unknown): WalletExecution {
  const body = record(value, 'execution')
  return {
    id: identifier(body['id'], 'id'),
    action: text(body['action'], 'action'),
    ...(typeof body['asset'] === 'string' ? { asset: body['asset'] } : {}),
    status: executionStatus(body['status']),
    ...(body['result'] !== undefined ? { result: body['result'] } : {}),
    ...(body['error'] !== undefined && body['error'] !== null ? { error: body['error'] } : {}),
    ...(typeof body['createdAt'] === 'string' ? { createdAt: body['createdAt'] } : {}),
    ...(typeof body['completedAt'] === 'string' ? { completedAt: body['completedAt'] } : {}),
  }
}

function executionStatus(value: unknown): WalletExecution['status'] {
  if (value === 'succeeded' || value === 'failed' || value === 'pending' || value === 'unknown') return value
  throw new RetryableAdapterError(`Unknown WhaleDance execution status: ${String(value)}`)
}

function errorBody(value: unknown): { message?: string; executionId?: string } {
  if (typeof value !== 'object' || value === null) return {}
  const body = value as Record<string, unknown>
  const rawMessage = body['message']
  const message = Array.isArray(rawMessage)
    ? rawMessage.filter((v): v is string => typeof v === 'string').join('; ')
    : typeof rawMessage === 'string' ? rawMessage : undefined
  return {
    ...(message !== undefined ? { message } : {}),
    ...(body['executionId'] !== undefined ? { executionId: String(body['executionId']) } : {}),
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RetryableAdapterError(`WhaleDance ${label} response has an invalid shape`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RetryableAdapterError(`WhaleDance response is missing ${label}`)
  return value
}

function decimal(value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(Number(value))) {
    throw new RetryableAdapterError(`WhaleDance response has invalid decimal ${label}`)
  }
  return String(value)
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new RetryableAdapterError(`WhaleDance response has invalid number ${label}`)
  return parsed
}

function identifier(value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
    throw new RetryableAdapterError(`WhaleDance response is missing ${label}`)
  }
  return String(value)
}

function orderSide(value: unknown): WalletOrder['side'] {
  if (value === 'B') return 'buy'
  if (value === 'A') return 'sell'
  throw new RetryableAdapterError(`Unknown WhaleDance order side: ${String(value)}`)
}

function isWalletScope(value: unknown): value is WalletScope {
  return value === 'wallet:read' || value === 'orders:write' || value === 'orders:cancel'
    || value === 'positions:close' || value === 'positions:manage'
}

function retryDelay(headers: Headers): number {
  const raw = headers.get('retry-after')
  const seconds = raw === null ? NaN : Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5000) : 500
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) }
  catch { return String(value) }
}

function safeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
