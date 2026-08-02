export { AsterAdapter } from './adapter.js'
export type { AsterCredentials } from './adapter.js'
export { asterPlugin } from './plugin.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
