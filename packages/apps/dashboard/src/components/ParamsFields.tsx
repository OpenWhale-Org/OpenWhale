'use client'

import type { ParamFieldDef } from '@openwhaleorg/core'

/** Schema-derived tuning fields (numbers/booleans/strings). Values as strings; empty = use default. */
export const FIELD_CLASS = 'rounded-md px-2 h-8 text-xs'
export const FIELD_STYLE = {
  background: 'transparent',
  color: 'var(--foreground)',
  border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
} as const

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
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }} title={f.description}>
          <span className="opacity-80">{f.displayName}</span>
          {f.type === 'boolean' ? (
            <select
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
              className={FIELD_CLASS}
              style={FIELD_STYLE}
            >
              <option value="">default{f.default !== undefined ? ` (${String(f.default)})` : ''}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
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
