'use client'

/**
 * The dashboard's on/off control.
 *
 * A native checkbox is the platform's, not ours: it renders as whatever the OS
 * decides, which beside these panels reads as an unfinished form. This is the
 * same switch the parameter form has always used for a boolean field, extracted
 * so a setting looks the same wherever it is set.
 *
 * For a set of choices — pick some of these venues, these kinds — a checkbox is
 * still the right control; `.checkbox` in globals.css dresses those.
 */
export function Switch({ checked, onChange, disabled, label, hint, id }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Rendered beside the switch and clickable with it. Omit for a bare control. */
  label?: React.ReactNode
  /** Second line, muted — what the setting means when it is on. */
  hint?: React.ReactNode
  id?: string
}) {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={typeof label === 'string' ? label : undefined}
      disabled={disabled ?? false}
      onClick={() => onChange(!checked)}
      className="relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50"
      style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
      {...(id ? { id } : {})}
    >
      <span
        className="absolute top-0.5 left-0 w-4 h-4 rounded-full bg-white transition-transform"
        style={{ transform: checked ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }}
      />
    </button>
  )

  if (label === undefined && hint === undefined) return control

  return (
    <div className="flex items-start gap-3">
      {control}
      {/* A label element would swallow the button's own click; this is a div
          whose text toggles the same switch. */}
      <div
        className={disabled ? 'min-w-0' : 'min-w-0 cursor-pointer'}
        onClick={() => { if (!disabled) onChange(!checked) }}
      >
        {label !== undefined && <span className="text-sm">{label}</span>}
        {hint !== undefined && <span className="block text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{hint}</span>}
      </div>
    </div>
  )
}
