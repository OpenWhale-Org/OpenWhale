export { VariationalAdapter, STATS_URL, symbolOf, tickerOf, perIntervalRate, nextSettlement, ladderBook } from './adapter.js'
export type { VariationalAdapterOptions, VariationalListing, VariationalStats } from './adapter.js'
export { variationalPlugin } from './plugin.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
