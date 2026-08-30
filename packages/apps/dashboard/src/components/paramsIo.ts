import type { ParamFieldDef } from '@openwhaleorg/core'

/**
 * Params ⇄ form values, and the import/export that travels between machines.
 *
 * The form edits strings — one per field, because every widget is an input —
 * while the API takes a typed `{ base, tunable }` object. Both directions live
 * here so an exported file and a saved instance are the same document, and so
 * an import can be described to the user BEFORE it overwrites anything.
 */

export type ParamValues = Record<string, string>

export interface ParamsObject {
  base: Record<string, unknown>
  tunable: Record<string, unknown>
}

/** How a value is written into a form field — the inverse of the parse below. */
function toFieldString(v: unknown): string {
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** Initialise string values from field defaults. */
export function defaultFieldValues(fields: ParamFieldDef[]): ParamValues {
  const out: ParamValues = {}
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.type === 'list' ? JSON.stringify(f.default) : String(f.default)
  }
  return out
}

export function fieldValuesFromParams(
  fields: ParamFieldDef[],
  params: { base?: Record<string, unknown>; tunable?: Record<string, unknown> } | undefined,
): ParamValues {
  const out = defaultFieldValues(fields)
  for (const f of fields) {
    const group = f.group === 'base' ? params?.base : params?.tunable
    const v = group?.[f.name]
    if (v !== undefined) out[f.name] = toFieldString(v)
  }
  return out
}

export function buildParamsFromFields(fields: ParamFieldDef[], values: ParamValues): ParamsObject {
  const base: Record<string, unknown> = {}
  const tunable: Record<string, unknown> = {}

  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    let parsed: unknown = raw
    if (field.type === 'number') {
      const n = parseFloat(raw)
      if (!isNaN(n)) parsed = n
    } else if (field.type === 'boolean') {
      parsed = raw === 'true'
    } else if (field.type === 'list') {
      try { parsed = JSON.parse(raw) } catch { continue }
    }
    if (field.group === 'base') base[field.name] = parsed
    else tunable[field.name] = parsed
  }

  return { base, tunable }
}

/** The exported document: what Save would send, pretty-printed. */
export function paramsJson(fields: ParamFieldDef[], values: ParamValues): string {
  return JSON.stringify(buildParamsFromFields(fields, values), null, 2)
}

export function paramsFilename(strategyId: string, instanceName?: string): string {
  const stem = (instanceName || strategyId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${stem || 'params'}-params.json`
}

/**
 * Do two value maps describe the same parameters?
 *
 * A missing key and an empty string are the same thing to the form — both mean
 * "nothing typed" — so a field cleared and reloaded must not read as an edit.
 */
export function sameValues(a: ParamValues, b: ParamValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false
  return true
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportChange {
  name: string
  label: string
  group: 'base' | 'tunable'
  /** Current form value, '' when the field is empty. */
  from: string
  to: string
}

export interface ImportPlan {
  /** Fields the file would overwrite — the list the dialog shows before applying. */
  changes: ImportChange[]
  /** Present in the file and already equal; applying them is a no-op. */
  unchanged: string[]
  /** Keys this strategy has no field for. Ignored, but named so a wrong file is obvious. */
  unknown: string[]
  /** Values after applying: current values with only the file's keys replaced. */
  values: ParamValues
}

/**
 * Flatten whatever the user pasted into `{ fieldName: value }`.
 *
 * A partial file is the normal case — someone copies two knobs out of a working
 * instance — so anything not named here is left alone rather than reset. Three
 * shapes are accepted because all three are things people actually have: the
 * export itself, a whole instance record, and a bare map of field names.
 */
function flatten(incoming: Record<string, unknown>): Record<string, unknown> {
  const params = (incoming.params ?? incoming) as Record<string, unknown>
  const base = params.base as Record<string, unknown> | undefined
  const tunable = params.tunable as Record<string, unknown> | undefined
  if (isPlainObject(base) || isPlainObject(tunable)) {
    return { ...(isPlainObject(base) ? base : {}), ...(isPlainObject(tunable) ? tunable : {}) }
  }
  return params
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse a pasted or uploaded document. Returns the plan, or why it cannot be read. */
export function planImport(
  fields: ParamFieldDef[],
  current: ParamValues,
  text: string,
): ImportPlan | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { error: `Not valid JSON: ${(err as Error).message}` }
  }
  if (!isPlainObject(parsed)) return { error: 'Expected a JSON object of parameters.' }

  const incoming = flatten(parsed)
  const byName = new Map(fields.map(f => [f.name, f]))
  const values: ParamValues = { ...current }
  const changes: ImportChange[] = []
  const unchanged: string[] = []
  const unknown: string[] = []

  for (const [key, raw] of Object.entries(incoming)) {
    const field = byName.get(key)
    if (!field) { unknown.push(key); continue }
    if (raw === null || raw === undefined) continue   // an explicit null clears nothing
    const next = toFieldString(raw)
    const from = current[key] ?? ''
    if (from === next) { unchanged.push(key); continue }
    changes.push({ name: key, label: field.displayName || key, group: field.group, from, to: next })
    values[key] = next
  }

  return { changes, unchanged, unknown, values }
}
