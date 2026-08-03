export { BinanceAdapter } from './adapter.js'
export type { BinanceCredentials } from './adapter.js'
export { binancePlugin } from './plugin.js'
export { BinancePerpAccount } from './account.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
