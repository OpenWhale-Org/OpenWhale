import { definePlugin } from '@openwhaleorg/core'
import { VariationalAdapter } from './adapter.js'

/**
 * Variational Omni venue plugin — public market data.
 *
 * One keyless `exchange/perp` cell: quotes, funding rates and open interest
 * for every Omni listing, which is enough for funding and spread monitors to
 * treat Omni as a venue (key: `variational`).
 *
 * No credential type: Omni has no public trading or account API yet, so there
 * is nothing a key could unlock. A credential form that accepts a key and then
 * does nothing with it would be worse than none. When the API opens, the
 * credential type and the credentialed form of this cell go here.
 */
export const variationalPlugin = definePlugin({
  name: 'variational',
  version: '0.1.0',

  adapters: [
    {
      kind: 'exchange/perp', type: 'variational',
      create: () => new VariationalAdapter(),
    },
  ],
})

export default variationalPlugin
