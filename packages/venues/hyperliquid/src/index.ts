export { HyperliquidAdapter } from './adapter.js'
export { UserTradesMonitor } from './monitor.js'
export { hyperliquidPlugin } from './plugin.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
