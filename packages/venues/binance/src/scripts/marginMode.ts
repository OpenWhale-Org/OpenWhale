import { z } from 'zod'
import type { AccountView, ScriptDefinition } from '@openwhaleorg/core'

/**
 * Account-wide margin mode of a classic USDⓈ-M futures account.
 *
 * Single-Asset Mode margins each asset on its own: USDT positions draw on
 * USDT, USDC positions on USDC. Multi-Assets Mode pools every eligible asset
 * (USDT, USDC, BTC, BNB, …, each at its haircut) into one cross margin
 * balance, so a USDC balance can carry a USDT-margined position.
 *
 * Binance refuses Multi-Assets Mode while any USDⓈ-M symbol is set to
 * isolated margin (-4167) — set, not merely holding a position. The switch is
 * therefore preceded by a scan of every symbol's configured margin type; the
 * ones with no open position can be moved to cross on request, the ones with a
 * position have to be closed or switched by the operator.
 *
 * Portfolio Margin accounts are already unified and have no such switch.
 */

const paramsSchema = z.object({
  account: z.string().default('').meta({
    displayName: 'Account',
    description: 'A Binance futures account with a bound credential. Leave empty to use the sole ready one.',
    i18n: { 'zh-CN': { displayName: '账户', description: '已绑定凭证的币安合约账户。留空则使用唯一一个可用账户。' } },
  }),
  mode: z.enum(['status', 'multi', 'single']).default('status').meta({
    displayName: 'Action',
    description: 'status: read only. multi: switch to Multi-Assets Mode. single: switch to Single-Asset Mode.',
    i18n: { 'zh-CN': { displayName: '操作', description: 'status：只查看。multi：切换为联合保证金。single：切换为单币保证金。' } },
  }),
  crossIdleIsolated: z.boolean().default(false).meta({
    displayName: 'Move idle isolated symbols to cross',
    description: 'Only for multi. Symbols set to isolated with no open position are switched to cross first; Binance refuses the switch otherwise. Symbols holding an isolated position are never touched.',
    i18n: { 'zh-CN': { displayName: '把无仓位的逐仓币种改为全仓', description: '仅对 multi 生效。币安要求所有币种都是全仓才能开联合保证金：无持仓的逐仓币种先改为全仓；有逐仓持仓的币种不会被改动。' } },
  }),
})

type BinanceFapi = {
  options: Record<string, unknown>
  fapiPrivateGetMultiAssetsMargin(params?: object): Promise<{ multiAssetsMargin?: boolean | string }>
  fapiPrivatePostMultiAssetsMargin(params: { multiAssetsMargin: string }): Promise<unknown>
  fapiPrivateGetPositionSideDual(params?: object): Promise<{ dualSidePosition?: boolean | string }>
  fapiPrivateGetSymbolConfig(params?: object): Promise<Array<{ symbol: string; marginType?: string }>>
  fapiPrivateV2GetPositionRisk(params?: object): Promise<Array<{ symbol: string; positionAmt?: string; marginType?: string; positionSide?: string }>>
  fapiPrivatePostMarginType(params: { symbol: string; marginType: 'CROSSED' | 'ISOLATED' }): Promise<unknown>
  fapiPrivateV2GetAccount(params?: object): Promise<{ totalMarginBalance?: string; availableBalance?: string; assets?: Array<{ asset: string; walletBalance?: string; marginAvailable?: boolean }> }>
}

const truthy = (v: unknown) => v === true || v === 'true'

export const marginModeScript: ScriptDefinition = {
  id: 'margin-mode',
  name: { en: 'Futures margin mode', 'zh-CN': '合约保证金模式' },
  description: {
    en: 'Read or switch a classic USDⓈ-M account between Single-Asset and Multi-Assets margin.',
    'zh-CN': '查看或切换经典 U 本位合约账户的单币保证金 / 联合保证金模式。',
  },
  paramsSchema,

  paramOptions: async (runtime) => {
    const rt = runtime as { listAccounts(): Promise<AccountView[]> }
    const accounts = await rt.listAccounts()
    return {
      account: accounts
        .filter(a => a.type === 'binance' && (a.kind ?? 'exchange/perp') === 'exchange/perp' && a.status === 'ready')
        .map(a => ({ value: a.name, label: a.name })),
    }
  },

  run: async ({ params, runtime, emit }) => {
    const p = paramsSchema.parse(params)
    const rt = runtime as {
      listAccounts(): Promise<AccountView[]>
      adapters: { resolve<T>(kind: string, type: string, credentialName?: string): Promise<T> }
    }
    const out: string[] = []
    const say = (s = '') => { out.push(s); emit?.(s) }

    const ready = (await rt.listAccounts())
      .filter(a => a.type === 'binance' && (a.kind ?? 'exchange/perp') === 'exchange/perp' && a.status === 'ready')
    if (ready.length === 0) return { text: 'No ready Binance futures account.' }
    const account = p.account === '' ? (ready.length === 1 ? ready[0] : undefined) : ready.find(a => a.name === p.account)
    if (!account) {
      return { text: p.account === ''
        ? `${ready.length} accounts are ready, pick one: ${ready.map(a => a.name).join(', ')}`
        : `No ready Binance futures account named "${p.account}"` }
    }
    if (!account.credential) return { text: `Account "${account.name}" has no bound credential` }

    const session = await rt.adapters.resolve<unknown>('exchange/perp', 'binance', account.credential)
    const ex = (session as { exchange?: BinanceFapi }).exchange
    if (!ex) return { text: 'This account resolves to a session without a ccxt exchange.' }
    if (ex.options['portfolioMargin'] === true) {
      return { text: `Account "${account.name}" trades through Portfolio Margin, which is already unified: there is no Single/Multi-Assets switch.` }
    }

    const readState = async () => {
      const [multi, dual, configs, risks] = await Promise.all([
        ex.fapiPrivateGetMultiAssetsMargin(),
        ex.fapiPrivateGetPositionSideDual(),
        ex.fapiPrivateGetSymbolConfig(),
        ex.fapiPrivateV2GetPositionRisk(),
      ])
      const open = new Set(risks.filter(r => Number(r.positionAmt ?? 0) !== 0).map(r => r.symbol))
      const isolated = configs.filter(c => c.marginType === 'ISOLATED').map(c => c.symbol)
      return {
        multi: truthy(multi.multiAssetsMargin),
        hedged: truthy(dual.dualSidePosition),
        isolatedHeld: isolated.filter(s => open.has(s)),
        isolatedIdle: isolated.filter(s => !open.has(s)),
        openCount: open.size,
      }
    }
    const report = (s: Awaited<ReturnType<typeof readState>>) => {
      say(`Account:        ${account.name}`)
      say(`Margin mode:    ${s.multi ? 'Multi-Assets' : 'Single-Asset'}`)
      say(`Position mode:  ${s.hedged ? 'Hedge' : 'One-way'}`)
      say(`Open symbols:   ${s.openCount}`)
      say(`Isolated, held: ${s.isolatedHeld.length ? s.isolatedHeld.join(', ') : '-'}`)
      say(`Isolated, idle: ${s.isolatedIdle.length ? `${s.isolatedIdle.length} (${s.isolatedIdle.slice(0, 12).join(', ')}${s.isolatedIdle.length > 12 ? ', ...' : ''})` : '-'}`)
    }

    const before = await readState()
    report(before)
    if (p.mode === 'status') return { text: out.join('\n'), json: before }

    const want = p.mode === 'multi'
    if (before.multi === want) {
      say('')
      say(`Already in ${want ? 'Multi-Assets' : 'Single-Asset'} Mode; nothing changed.`)
      return { text: out.join('\n'), json: before }
    }

    if (want) {
      if (before.isolatedHeld.length > 0) {
        say('')
        say(`Refused: ${before.isolatedHeld.join(', ')} hold isolated positions. Close them or switch them to cross first.`)
        return { text: out.join('\n'), json: before }
      }
      if (before.isolatedIdle.length > 0) {
        if (!p.crossIdleIsolated) {
          say('')
          say(`Refused: ${before.isolatedIdle.length} symbols are set to isolated (no position). Binance requires cross on every symbol; rerun with "Move idle isolated symbols to cross" on.`)
          return { text: out.join('\n'), json: before }
        }
        say('')
        for (const symbol of before.isolatedIdle) {
          try {
            await ex.fapiPrivatePostMarginType({ symbol, marginType: 'CROSSED' })
            say(`  ${symbol}: isolated -> cross`)
          } catch (err) {
            say(`  ${symbol}: failed (${(err as Error).message})`)
          }
        }
      }
    }

    say('')
    try {
      await ex.fapiPrivatePostMultiAssetsMargin({ multiAssetsMargin: want ? 'true' : 'false' })
    } catch (err) {
      say(`Switch failed: ${(err as Error).message}`)
      return { text: out.join('\n'), json: before }
    }
    const after = await readState()
    say(`Switched to ${after.multi ? 'Multi-Assets' : 'Single-Asset'} Mode.`)
    if (after.multi) {
      const acct = await ex.fapiPrivateV2GetAccount()
      const collateral = (acct.assets ?? []).filter(a => a.marginAvailable && Number(a.walletBalance ?? 0) !== 0)
      say(`Margin balance: ${acct.totalMarginBalance ?? '?'} USD, available ${acct.availableBalance ?? '?'} USD`)
      if (collateral.length) say(`Collateral:     ${collateral.map(a => `${a.asset} ${Number(a.walletBalance)}`).join(', ')}`)
    }
    return { text: out.join('\n'), json: { before, after } }
  },
}
