export { HyperliquidAdapter, refuseOrderBuilderOverride } from './adapter.js'
export { BUILDER_ADDRESS, BUILDER_TENTHS_BP, BUILDER_MAX_FEE_RATE } from './adapter.js'
export type { HyperliquidCredentials } from './adapter.js'
export { hyperliquidCredentialSchema, buildHyperliquidAdapter, testHyperliquidCredential } from './plugin.js'
export { UserTradesMonitor } from './monitor.js'
export { hyperliquidPlugin } from './plugin.js'
export { priorityProbeScript } from './scripts/priorityProbe.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
