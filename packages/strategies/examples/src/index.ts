export { CopyTradingStrategy } from './strategies/CopyTradingStrategy.js'
export { MomentumBreakoutStrategy } from './strategies/MomentumBreakoutStrategy.js'
export { MeanReversionStrategy } from './strategies/MeanReversionStrategy.js'
export { ScheduledAccumulationStrategy } from './strategies/ScheduledAccumulationStrategy.js'
export { AiAnalystStrategy } from './strategies/AiAnalystStrategy.js'
export * from './indicators.js'
export { examplesPlugin } from './plugin.js'

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
