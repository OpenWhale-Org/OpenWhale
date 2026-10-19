import { definePlugin } from '@openwhaleorg/core'
import { accountHistoryScript } from './history/script.js'

/**
 * What every ccxt venue shares, as a plugin: no credential types, no
 * adapter cells — those are each venue's own — only the scripts that work
 * across the lot because they speak the shared adapter surface.
 */
export const ccxtPlugin = definePlugin({
  name: 'ccxt',
  version: '1.0.0',
  scripts: [accountHistoryScript],
})

export default ccxtPlugin
