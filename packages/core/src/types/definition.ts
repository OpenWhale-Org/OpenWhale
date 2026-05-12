// ── Param field UI schema ─────────────────────────────────────────────────────

export type ParamFieldType = 'string' | 'number' | 'boolean' | 'options'

export interface ParamFieldOption {
  label: string
  value: string | number | boolean
  description?: string
}

/**
 * UI metadata attached to a Zod field via .meta({ ... }).
 * All fields are optional — missing fields fall back to sensible defaults.
 */
export interface ParamFieldMeta {
  displayName?: string
  description?: string
  hint?: string
  placeholder?: string
  options?: ParamFieldOption[]
  displayOptions?: {
    show?: Record<string, (string | number | boolean)[]>
    hide?: Record<string, (string | number | boolean)[]>
  }
}

export interface ParamFieldDef {
  /** Field key in the params object */
  name: string
  /** Human-readable label shown in the UI */
  displayName: string
  /** Field type — controls which input widget is rendered */
  type: ParamFieldType
  /** Which params group this field belongs to */
  group: 'base' | 'tunable'
  /** Default value (used as placeholder hint and Zod default) */
  default?: unknown
  /** Short description shown below the field */
  description?: string
  /** Inline hint shown next to the label */
  hint?: string
  /** Input placeholder text */
  placeholder?: string
  /** Whether the field is required */
  required?: boolean
  /** Options for type='options' */
  options?: ParamFieldOption[]
  /**
   * Conditional visibility — field is shown only when the referenced
   * sibling field has one of the listed values.
   */
  displayOptions?: {
    show?: Record<string, (string | number | boolean)[]>
    hide?: Record<string, (string | number | boolean)[]>
  }
}

// ── Component definitions ─────────────────────────────────────────────────────

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
  /** Field descriptors for generic UI rendering. Optional — falls back to JSON editor if absent. */
  paramsFields?: ParamFieldDef[]
  createdAt: string
  updatedAt: string
}
