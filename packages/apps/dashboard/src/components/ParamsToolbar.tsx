'use client'

import { useRef, useState } from 'react'
import type { ParamFieldDef } from '@openwhaleorg/core'
import { Modal } from './Modal'
import { planImport, paramsJson, paramsFilename, type ImportPlan, type ParamValues } from './paramsIo'

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
  const fileRef = useRef<HTMLInputElement>(null)
  const result = text.trim() ? planImport(fields, values, text) : null
  const plan = result && !('error' in result) ? (result as ImportPlan) : null
  const error = result && 'error' in result ? result.error : ''

  async function pickFile(file: File | undefined) {
    if (!file) return
    setText(await file.text())
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
          onChange={(e) => setText(e.target.value)}
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
                <div className="px-3 py-1.5 text-xs" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                  {plan.changes.length} field{plan.changes.length > 1 ? 's' : ''} will be overwritten
                </div>
                <div className="max-h-64 overflow-y-auto scroll-hidden">
                  {plan.changes.map(c => (
                    <div key={c.name} className="px-3 py-1.5 text-xs flex items-baseline gap-2" style={{ borderTop: '1px solid var(--border)' }}>
                      <span className="shrink-0" style={{ color: 'var(--foreground)' }}>{c.label}</span>
                      <span className="font-mono shrink-0" style={{ color: 'var(--muted)' }}>{c.name}</span>
                      <span className="ml-auto font-mono flex items-baseline gap-1.5 min-w-0">
                        <span className="truncate" style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>{c.from || '—'}</span>
                        <span style={{ color: 'var(--muted)' }}>→</span>
                        <span className="truncate" style={{ color: 'var(--success)' }}>{c.to}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="text-xs flex flex-wrap gap-x-4 gap-y-1" style={{ color: 'var(--muted)' }}>
              {plan.unchanged.length > 0 && <span>{plan.unchanged.length} already identical</span>}
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
            disabled={!plan || plan.changes.length === 0}
            onClick={() => plan && onApply(plan.values)}
          >
            Apply{plan && plan.changes.length > 0 ? ` ${plan.changes.length}` : ''}
          </button>
        </div>
      </div>
    </Modal>
  )
}
