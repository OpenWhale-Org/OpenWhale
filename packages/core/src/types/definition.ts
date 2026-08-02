// ── Param field UI schema ─────────────────────────────────────────────────────

export type ParamFieldType = 'string' | 'number' | 'boolean' | 'options' | 'list'

export interface ParamFieldOption {
  label: string
  value: string | number | boolean
  description?: string
}

/**
 * Render a number as a drag slider (with an exact-value box beside it).
 * Only meaningful on number fields / columns; requires a bounded range —
 * an unbounded quantity has no slider geometry.
 */
export interface ParamFieldSlider {
  min: number
  max: number
  step?: number
}

/**
 * One column of a `list` param — the fields every row carries.
 *
 * Deliberately a subset of ParamFieldDef: rows are data, not forms, so
 * conditional visibility, catalogues and nested lists don't apply.
 */
export interface ListColumnDef {
  name: string
  displayName: string
  type: 'string' | 'number' | 'boolean' | 'options'
  options?: ParamFieldOption[]
  slider?: ParamFieldSlider
  /** Render a searchable market picker for this cell (see ParamFieldCatalogue). */
  catalogue?: ParamFieldCatalogue
  /** Short unit suffix rendered after the input ('σ', '%', '$'). */
  unit?: string
  placeholder?: string
  description?: string
  /** Value a freshly added row starts with. */
  default?: unknown
}

/**
 * Structure of a `list` param: an ordered array of uniform rows, each row an
 * object described by `columns`. The natural shape for ladders and tier
 * tables — "at level X do Y" — where a CSV string would hide the structure.
 *
 * Derived from a `z.array(z.object({...}))` param: the element object's shape
 * becomes the columns, each column's `.meta()` carrying its own display info.
 */
export interface ListParamDef {
  columns: ListColumnDef[]
  /** Label for the add-row button ('Add tier'). */
  addLabel?: string
}

/**
 * UI metadata attached to a Zod field via .meta({ ... }).
 * All fields are optional — missing fields fall back to sensible defaults.
 */
export interface ParamFieldMeta {
  /** Display section within the group — dashboard renders a header per section. */
  section?: string
  displayName?: string
  description?: string
  hint?: string
  placeholder?: string
  options?: ParamFieldOption[]
  displayOptions?: {
    show?: Record<string, (string | number | boolean)[]>
    hide?: Record<string, (string | number | boolean)[]>
  }
  /**
   * Render a searchable catalogue picker instead of a plain text input, whose
   * entries are fetched live from the venue this field's value belongs to.
   *
   * Unlike `options` (a fixed list baked into the schema) the candidate set is
   * far too large to inline and depends on another value in the same form, so
   * only the COORDINATES are declared here and the client resolves them.
   *
   * The field stays a plain string: a client that ignores this marker renders
   * a text box and the form still works.
   */
  catalogue?: ParamFieldCatalogue
  /** Verify the chosen value(s) against the venue before activation. */
  availability?: ParamAvailability
  /** The field holds several values (comma-separated in the stored string). */
  multiple?: boolean
  /** Render this number as a drag slider with the given range. */
  slider?: ParamFieldSlider
  /** Short unit suffix rendered after the input ('σ', '%', '$'). */
  unit?: string
  /**
   * Extra list-level settings for an array-of-objects param. The columns
   * themselves derive from the element schema — only presentation extras
   * (add-button label) live here.
   */
  list?: Omit<ListParamDef, 'columns'>
}

/**
 * Where a picker should source its entries.
 *
 * `venueField` names the sibling field holding the venue. Omit it when the
 * venue is not a form field at all — strategy params derive it from the bound
 * account (rule: no venue param when an account binding implies it), and the
 * form supplies it from context.
 */
export interface ParamFieldCatalogue {
  /** What is being picked. 'market' = the venue's listed symbols. */
  source: 'market'
  /** Sibling field name holding the venue; omitted when the venue comes from form context. */
  venueField?: string
  /** Kind whose adapter column serves the catalogue, e.g. 'exchange/perp'. */
  kind?: string
  /** Restrict to one market type ('swap' for perps, 'spot' for spot). */
  marketType?: string
}

/**
 * Per-field availability checking — "can this venue actually do what I picked?"
 *
 * Distinct from `catalogue`, which SOURCES options: a catalogue answers "what
 * exists", availability answers "does MY choice work on the account I am about
 * to bind". The check runs server-side (it needs the venue) and is advisory:
 * the form reports each value's verdict, it never blocks submission, because a
 * venue that cannot answer must not stop a user who knows better.
 */
export interface ParamAvailability {
  /**
   * Built-in check: every value must be a listed market on the venue. Values
   * may be composite — `separator` splits one value into the symbols to check.
   */
  source?: 'market'
  /** Kind whose adapter column serves the market list. Default 'exchange/perp'. */
  kind?: string
  /** Split a composite value (e.g. an ETF pair) into individual symbols. */
  separator?: string
  /**
   * Name of a checker the component provides, for logic the built-in cannot
   * express (liquidity floors, venue-specific contract rules, pair sanity).
   * Overrides `source`.
   */
  checker?: string
}

/** One value's verdict. `available: true` with a reason = a warning, not a failure. */
export interface AvailabilityVerdict {
  value: string
  available: boolean
  /** Why unavailable, or a caveat worth showing when it is available. */
  reason?: string
}

/**
 * A component-provided checker. Receives the venue's markets already fetched
 * (keyless, cached by the gateway) so checkers stay pure and unit-testable.
 */
export type AvailabilityChecker = (
  values: string[],
  ctx: { venue: string; markets: Array<Record<string, unknown>> },
) => AvailabilityVerdict[] | Promise<AvailabilityVerdict[]>

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
  /** Display section within the group — the dashboard renders a header per section, in first-appearance order. */
  section?: string
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
  /** Render a live catalogue picker (see ParamFieldCatalogue); degrades to a text input. */
  catalogue?: ParamFieldCatalogue
  /** Verify the chosen value(s) against the bound account's venue (see ParamAvailability). */
  availability?: ParamAvailability
  /** Field accepts several values — the form renders a multi-select. */
  multiple?: boolean
  /** Render this number as a drag slider with the given range. */
  slider?: ParamFieldSlider
  /** Short unit suffix rendered after the input. */
  unit?: string
  /** Row structure for type='list' — columns derived from the array's element schema. */
  list?: ListParamDef
}

// ── Component definitions ─────────────────────────────────────────────────────

export interface MonitorDefinition {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'plugin' | 'compiled'
  pluginName?: string
  compiledPath?: string
  /** Key structure fields — derived from the monitor's keySchema at registration. */
  keyFields?: ParamFieldDef[]
  /** This monitor can reconstruct history on first subscribe (see BaseMonitor.backfill). */
  supportsBackfill?: boolean
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

/**
 * A self-contained HTML document embedded in the param form — a diagram,
 * worked example, or interactive widget. Rendered in a sandboxed iframe
 * (scripts allowed, same-origin denied); the CURRENT form values stream in
 * via postMessage on every edit, so the page can react to what the user types:
 *
 *   window.addEventListener('message', (e) => {
 *     if (e.data?.type === 'ow-params') render(e.data.values)  // { fieldName: string }
 *   })
 *
 * Values arrive as the raw input strings, keyed by field name.
 */
export interface ParamIllustration {
  /** Render after this section's fields (matches ParamFieldMeta.section); top of the form when omitted. */
  section?: string
  title?: string
  html: string
  /** iframe height in px. Default 220. */
  height?: number
}

export interface StrategyDefinition {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'plugin' | 'compiled'
  pluginName?: string
  compiledPath?: string
  /**
   * Registry keys of the monitors this strategy depends on.
   * Derived from the strategy class's `monitors` declarations at registration —
   * omit when registering; present on every registered definition.
   */
  monitorIds?: string[]
  /** Registry keys of the executors this strategy depends on. Derived like monitorIds. */
  executorIds?: string[]
  /**
   * Account slots this strategy needs — derived from the class's accountTypes
   * at registration. UIs use this to filter the credential picker: `kind`
   * accepts any credential whose type has a factory for it; `type` pins an
   * exact credential type (venue-locked Reader subclasses).
   */
  accountRequirements?: Array<{ label: string; kind?: string; type?: string; capability?: string }>
  /** LLM slots (label + defaults) — derived from the class's llms declarations. */
  llmRequirements?: Array<{ label: string; model: string; credentialName?: string; settings?: Record<string, unknown> }>
  /** Field descriptors for generic UI rendering. Derived from the params schemas at registration. */
  paramsFields?: ParamFieldDef[]
  /** Interactive/illustrative docs shown inside the param form. Derived from the strategy class at registration. */
  paramsIllustrations?: ParamIllustration[]
  createdAt: string
  updatedAt: string
}
