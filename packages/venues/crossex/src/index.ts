export { CrossExAdapter, CrossExPublicAdapter } from './adapter.js'
export { CrossExClient, CROSSEX_REST_BASE, CROSSEX_WS_PUBLIC, CROSSEX_WS_PRIVATE } from './client.js'
export type { CrossExClientOptions } from './client.js'
export {
  parseCrossExSymbol, formatCrossExSymbol, underlyingSymbol, underlyingVenue, ruleToMarket, roundToStep,
} from './symbols.js'
export type { CrossExSymbolParts, CrossExRule } from './symbols.js'
export { crossexPlugin } from './plugin.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
