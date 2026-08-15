import type { ZodObject, ZodRawShape } from 'zod'
import type { ParamFieldDef } from './definition.js'

/**
 * Scripts — operator utilities a plugin ships alongside its strategies: plan
 * previews, fit inspectors, one-off reports. A script is trusted plugin code
 * that runs server-side against the live runtime and returns a text report;
 * the dashboard renders a params form (from paramsSchema) and the output.
 *
 * Deliberately NOT instances: no lifecycle, no persistence, no triggers —
 * run-on-click only. Anything that needs to run on a schedule belongs in a
 * monitor or strategy instead.
 */

export interface ScriptResult {
  /** Preformatted report, rendered monospace on the dashboard. */
  text: string
  /** Structured payload for programmatic callers (shown as collapsible JSON). */
  json?: unknown
  /**
   * Attachments the operator can save — a standalone HTML report, a CSV, an
   * SQL dump. The dashboard offers each as a download; nothing is written to
   * disk on the server, so there is no report directory to grow unbounded and
   * nothing to clean up or authorize separately.
   *
   * Content travels inline in the result, so keep attachments to the size of
   * a report rather than a dataset. A file that would not comfortably fit in
   * a browser tab belongs behind its own streaming route instead.
   */
  files?: Array<{
    /** Suggested filename, extension included. */
    name: string
    /** Defaults to 'text/plain; charset=utf-8'. */
    mime?: string
    content: string
  }>
}

export interface ScriptContext {
  /** Validated against paramsSchema (defaults applied). */
  params: Record<string, unknown>
  /**
   * Push a line to the caller WHILE the script runs, for scripts whose work
   * outlives a request's patience.
   *
   * The reason this exists is not comfort: the dashboard proxies /api through
   * Next, which cuts the connection at 30s, so a script that only spoke at the
   * end lost everything it had done. A run that emits keeps the connection fed
   * and shows progress; the returned ScriptResult is still the record of
   * record. Absent when the caller does not stream, so scripts must treat it
   * as optional and still return a complete result.
   */
  emit?: (line: string) => void
  /**
   * The live OpenWhaleRuntime. Typed loosely so plugin packages don't need
   * the runtime's full type surface — cast to what the script actually uses
   * (listInstanceViews, getStrategy, …).
   */
  runtime: unknown
}

export interface ScriptDefinition {
  /** Qualified to '<plugin>/<id>' at load. */
  id: string
  name: string
  description?: string
  paramsSchema?: ZodObject<ZodRawShape>
  /**
   * Live-resolved select options, keyed by param name — for params whose
   * candidates only exist at runtime (instance ids, account names). Resolved
   * on every listing, so the dropdown always reflects the current world;
   * the param itself stays a plain string in the schema.
   */
  paramOptions?(runtime: unknown): Promise<Record<string, Array<{ value: string; label: string }>>>
  run(ctx: ScriptContext): Promise<ScriptResult>
}

/** Serializable listing entry (dashboard Scripts page). */
export interface ScriptInfo {
  id: string
  name: string
  description?: string
  pluginName: string
  paramsFields?: ParamFieldDef[]
}
