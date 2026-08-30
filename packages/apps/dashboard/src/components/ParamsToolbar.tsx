'use client'

import { useCallback, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { ParamFieldDef } from '@openwhaleorg/core'
import { Modal } from './Modal'
import { applyChanges, fieldValuesFromParams, planImport, paramsJson, paramsFilename, type ImportPlan, type ParamValues } from './paramsIo'

/** Monaco is ~1 MB and only the JSON view needs it — loaded when asked for. */
const CodeEditor = dynamic(() => import('./CodeEditor').then(m => m.CodeEditor), {
  ssr: false,
  loading: () => <div className="text-xs p-4" style={{ color: 'var(--muted)' }}>Loading editor…</div>,
})

/**
 * The parameter panel's action bar: view switch, undo/redo, import/export, save.
 *
 * It is meant to be rendered inside a `position: sticky` header so it stays
 * reachable down a long form — the whole point of gathering the actions here is
 * that saving should never require scrolling back up.
 */

export type ParamsView = 'form' | 'json'

export function ParamsToolbar({
  fields, values, view, onView, history, onImport, strategyId, instanceName, disabled,
}: {
  fields: ParamFieldDef[]
  values: ParamValues
  view: ParamsView
  onView: (v: ParamsView) => void
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean }
  /** Applies an accepted import — one undo step, already merged over current values. */
  onImport: (values: ParamValues) => void
  strategyId: string
  instanceName?: string
  /** JSON that has not parsed yet: exporting or switching view would lose it. */
  disabled?: boolean
}) {
  const [importing, setImporting] = useState(false)
  const [exported, setExported] = useState(false)

  function exportFile() {
    const blob = new Blob([paramsJson(fields, values)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = paramsFilename(strategyId, instanceName)
    a.click()
    URL.revokeObjectURL(url)
    setExported(true)
    setTimeout(() => setExported(false), 1_500)
  }

  return (
    <>
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['form', 'json'] as const).map(v => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              disabled={disabled && v !== view}
              title={v === 'json' ? 'Edit the parameters as JSON' : 'Edit the parameters as fields'}
              className="px-2 py-1 text-xs"
              style={{
                background: view === v ? 'var(--accent)' : 'transparent',
                color: view === v ? '#fff' : 'var(--muted)',
              }}
            >
              {v === 'form' ? 'Form' : 'JSON'}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={history.undo} disabled={!history.canUndo} title="Undo (⌘Z)" aria-label="Undo">↶</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={history.redo} disabled={!history.canRedo} title="Redo (⌘⇧Z)" aria-label="Redo">↷</button>
        <button type="button" className="btn btn-soft btn-sm" onClick={() => setImporting(true)}>Import</button>
        <button type="button" className="btn btn-soft btn-sm" onClick={exportFile} disabled={disabled}>{exported ? 'Saved ✓' : 'Export'}</button>
      </div>
      {importing && (
        <ImportDialog
          fields={fields}
          values={values}
          onClose={() => setImporting(false)}
          onApply={(next) => { onImport(next); setImporting(false) }}
        />
      )}
    </>
  )
}

/**
 * Read a file or a paste, then show exactly which fields it would overwrite.
 *
 * A parameter file is usually partial and usually lands on an instance that is
 * already running, so "what will this change" is the question worth answering
 * before anything moves — every field the file does not name keeps its value.
 */
function ImportDialog({ fields, values, onClose, onApply }: {
  fields: ParamFieldDef[]
  values: ParamValues
  onClose: () => void
  onApply: (values: ParamValues) => void
}) {
  const [text, setText] = useState('')
  /* Fields the user struck off this import. A file is rarely wanted whole —
     someone copies an instance's parameters and keeps their own symbols. */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)
  const result = text.trim() ? planImport(fields, values, text) : null
  const plan = result && !('error' in result) ? (result as ImportPlan) : null
  const error = result && 'error' in result ? result.error : ''
  const taken = plan ? plan.changes.filter(c => !skipped.has(c.name)) : []

  const toggle = (name: string) => setSkipped(prev => {
    const next = new Set(prev)
    if (!next.delete(name)) next.add(name)
    return next
  })

  /** A new document is a new decision — nothing carries over from the last one. */
  function load(next: string) {
    setText(next)
    setSkipped(new Set())
  }

  function apply() {
    if (plan) onApply(applyChanges(values, taken))
  }

  async function pickFile(file: File | undefined) {
    if (!file) return
    load(await file.text())
  }

  return (
    <Modal onClose={onClose} maxWidth="42rem">
      <div className="p-4 flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Import parameters</h3>
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            A partial file is fine: only the fields it names are replaced, everything else keeps its value.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>Choose file…</button>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>or paste below</span>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </div>

        <textarea
          value={text}
          onChange={(e) => load(e.target.value)}
          onDrop={(e) => { e.preventDefault(); void pickFile(e.dataTransfer.files?.[0]) }}
          rows={7}
          spellCheck={false}
          placeholder={'{\n  "tunable": {\n    "entryZ": 1.8\n  }\n}'}
          className="rounded-md px-3 py-2 text-xs font-mono resize-y w-full"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}` }}
        />

        {error && <div className="text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}

        {plan && (
          <div className="flex flex-col gap-2">
            {plan.changes.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                Nothing to change — every parameter in this file already holds that value.
              </div>
            ) : (
              <div className="rounded-md" style={{ border: '1px solid var(--border)' }}>
                <div className="px-3 py-1.5 text-xs flex items-center gap-2" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                  <span>
                    {taken.length === plan.changes.length
                      ? `${plan.changes.length} field${plan.changes.length > 1 ? 's' : ''} will be overwritten`
                      : `${taken.length} of ${plan.changes.length} fields will be overwritten`}
                  </span>
                  {skipped.size > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => setSkipped(new Set())}>
                      Restore all
                    </button>
                  )}
                </div>
                <div className="max-h-64 overflow-y-auto scroll-hidden">
                  {plan.changes.map(c => {
                    const off = skipped.has(c.name)
                    return (
                      <div
                        key={c.name}
                        className="px-3 py-1.5 text-xs flex items-baseline gap-2"
                        style={{ borderTop: '1px solid var(--border)', opacity: off ? 0.45 : 1 }}
                      >
                        <span className="shrink-0" style={{ color: 'var(--foreground)' }}>{c.label}</span>
                        <span className="font-mono shrink-0" style={{ color: 'var(--muted)' }}>{c.name}</span>
                        <span className="ml-auto font-mono flex items-baseline gap-1.5 min-w-0">
                          <span className="truncate" style={{ color: 'var(--muted)', textDecoration: off ? 'none' : 'line-through' }}>{c.from || '—'}</span>
                          <span style={{ color: 'var(--muted)' }}>→</span>
                          <span className="truncate" style={{ color: off ? 'var(--muted)' : 'var(--success)', textDecoration: off ? 'line-through' : 'none' }}>{c.to}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => toggle(c.name)}
                          title={off ? `Import ${c.name} after all` : `Keep the current ${c.name}`}
                          aria-label={off ? `Restore ${c.name}` : `Skip ${c.name}`}
                          className="btn btn-ghost btn-sm shrink-0 self-center"
                          style={{ padding: '0 0.4rem' }}
                        >
                          {off ? '↺' : '×'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="text-xs flex flex-wrap gap-x-4 gap-y-1" style={{ color: 'var(--muted)' }}>
              {plan.unchanged.length > 0 && <span>{plan.unchanged.length} already identical</span>}
              {skipped.size > 0 && <span>{skipped.size} kept as {skipped.size > 1 ? 'they are' : 'it is'}</span>}
              {plan.unknown.length > 0 && (
                <span style={{ color: 'var(--warning)' }}>
                  ignored (not a parameter here): <span className="font-mono">{plan.unknown.join(', ')}</span>
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={taken.length === 0}
            onClick={apply}
          >
            Apply{taken.length > 0 ? ` ${taken.length}` : ''}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── JSON view ─────────────────────────────────────────────────────────────────

export interface ParamsJson {
  /** What the editor shows: the live draft, or the current values rendered. */
  text: string
  /** Why the draft has not been applied. Empty while it parses. */
  error: string
  edit: (text: string) => void
  /** Drop the draft — on leaving the view, or when the values are reseeded. */
  reset: () => void
}

/**
 * The JSON view's state.
 *
 * It edits TEXT, not values: half-typed JSON does not parse, and a form that
 * flickered back to defaults on every keystroke would be unusable. The draft
 * commits only when it parses — and only when it carries the groups, because a
 * flat map names none and applying it would silently reset every field.
 *
 * Unlike Import, this document is the WHOLE thing: a field left out of it falls
 * back to its default, exactly as it would on a freshly created instance.
 */
export function useParamsJson(
  fields: ParamFieldDef[],
  values: ParamValues,
  setValues: (next: ParamValues) => void,
): ParamsJson {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const edit = useCallback((text: string) => {
    setDraft(text)
    try {
      const parsed: unknown = JSON.parse(text)
      const doc = parsed as { base?: unknown; tunable?: unknown }
      const grouped = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
      if (!(grouped(parsed) && (grouped(doc.base) || grouped(doc.tunable)))) {
        setError('Expected a JSON object with "base" and/or "tunable" groups.')
        return
      }
      setError('')
      setValues(fieldValuesFromParams(fields, doc as { base?: Record<string, unknown>; tunable?: Record<string, unknown> }))
    } catch (err) {
      setError((err as Error).message)
    }
  }, [fields, setValues])

  const reset = useCallback(() => { setDraft(null); setError('') }, [])

  return { text: draft ?? paramsJson(fields, values), error, edit, reset }
}

export function ParamsJsonView({ json, path, height = '60vh', note }: {
  json: ParamsJson
  /** Monaco model path — one per document, so undo history does not bleed across instances. */
  path: string
  height?: string
  note: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs" style={{ color: 'var(--muted)' }}>{note}</p>
      <div className="rounded-md overflow-hidden" style={{ border: `1px solid ${json.error ? 'var(--danger)' : 'var(--border)'}` }}>
        <CodeEditor path={path} language="json" value={json.text} onChange={json.edit} height={height} />
      </div>
      {json.error && <div className="text-xs" style={{ color: 'var(--danger)' }}>{json.error}</div>}
    </div>
  )
}
