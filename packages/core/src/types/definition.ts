export interface MonitorDefinition {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'plugin' | 'compiled'
  pluginName?: string
  compiledPath?: string
  createdAt: string
  updatedAt: string
}

export interface ExecutorDefinition {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'plugin' | 'compiled'
  pluginName?: string
  compiledPath?: string
  supportedActions: string[]
  createdAt: string
  updatedAt: string
}

export interface StrategyDefinition {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'plugin' | 'compiled'
  pluginName?: string
  compiledPath?: string
  monitorIds: string[]
  executorIds: string[]
  createdAt: string
  updatedAt: string
}
