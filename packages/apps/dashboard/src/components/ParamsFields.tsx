'use client'

import { Select } from './Select'

import type { ParamFieldDef } from '@/lib/core-types'

/** Schema-derived tuning fields (numbers/booleans/strings). Values as strings; empty = use default. */
export const FIELD_CLASS = 'rounded-md px-2 h-8 text-xs'
export const FIELD_STYLE = {
  background: 'transparent',
  color: 'var(--foreground)',
  border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
} as const

/** `displayOptions` against the values — an empty field counts as its default, since that is what it sends. */
function visible(f: ParamFieldDef, fields: ParamFieldDef[], values: Record<string, string>): boolean {
  const d = f.displayOptions
  if (!d) return true
  const current = (key: string) => {
    const v = values[key] ?? ''
    if (v !== '') return v
    const dflt = fields.find(x => x.name === key)?.default
    return dflt === undefined ? '' : String(dflt)
  }
  for (const [key, allowed] of Object.entries(d.show ?? {})) if (!allowed.map(String).includes(current(key))) return false
  for (const [key, blocked] of Object.entries(d.hide ?? {})) if (blocked.map(String).includes(current(key))) return false
  return true
}

/** ISO UTC ↔ the local wall-clock string a datetime-local input speaks. */
function isoToLocal(iso: string): string {
  const d = iso ? new Date(iso) : undefined
  if (!d || Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 23)
}

export function ParamsFields({ fields, values, onChange }: {
  fields: ParamFieldDef[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  /* Quiet inputs on purpose. Each field used to be a filled box with a full
     border sitting inside another filled box with a full border, and a row of
     those reads as moulded plastic rather than as a form. One border, no fill,
     and the surface underneath shows through. */
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {fields.filter(f => visible(f, fields, values)).map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }} title={f.description}>
          <span className="opacity-80">{f.displayName}</span>
          {f.type === 'boolean' ? (
            <Select
              size="sm"
              className="w-36"
              value={values[f.name] ?? ''}
              onChange={(v) => onChange(f.name, v)}
              options={[
                { value: '', label: `default${f.default !== undefined ? ` (${String(f.default)})` : ''}` },
                { value: 'true', label: 'true' },
                { value: 'false', label: 'false' },
              ]}
            />
          ) : f.type === 'options' && f.options ? (
            <Select
              size="sm"
              className="w-44"
              value={values[f.name] ?? ''}
              onChange={(v) => onChange(f.name, v)}
              allowCustom={f.suggestions === true}
              options={[
                { value: '', label: `default${f.default !== undefined ? ` (${String(f.default)})` : ''}` },
                ...f.options.map(o => ({ value: String(o.value), label: o.label })),
              ]}
            />
          ) : f.widget === 'datetime' ? (
            <input
              type="datetime-local"
              step="0.001"
              value={isoToLocal(values[f.name] ?? '')}
              onChange={(e) => {
                const t = e.target.value ? new Date(e.target.value) : undefined
                onChange(f.name, t && !Number.isNaN(t.getTime()) ? t.toISOString() : '')
              }}
              className={`${FIELD_CLASS} w-56`}
              style={{ ...FIELD_STYLE, colorScheme: 'dark light' }}
            />
          ) : (
            <input
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
              placeholder={f.default !== undefined ? String(f.default) : ''}
              className={`${FIELD_CLASS} w-36`}
              style={FIELD_STYLE}
            />
          )}
        </label>
      ))}
    </div>
  )
}

/** String field values → typed params object; empty fields omitted so schema defaults apply. */
export function buildParams(fields: ParamFieldDef[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = (values[f.name] ?? '').trim()
    if (raw === '') continue
    out[f.name] = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw
  }
  return out
}
