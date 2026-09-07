'use client'

import { useState } from 'react'

/**
 * Rename something where it is written.
 *
 * The gesture differs by where the name sits. A page title is inert, so one
 * click can mean "edit it". A name on a card is inside something clickable —
 * the card opens, the row selects — so there it takes a double-click, which is
 * what people try first anyway.
 *
 * The display stays the caller's: this swaps in an input while editing and
 * hands back the trimmed name, nothing more. Enter and blur commit, Escape
 * abandons, and an unchanged or empty name saves nothing.
 */
export function InlineRename({
  value, onSave, trigger = 'doubleClick', title, inputClassName, inputStyle, children,
}: {
  value: string
  onSave: (next: string) => void | Promise<void>
  trigger?: 'click' | 'doubleClick'
  /** Tooltip on the display, e.g. "Double-click to rename". */
  title?: string
  inputClassName?: string
  inputStyle?: React.CSSProperties
  children: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const start = (e: React.MouseEvent) => {
    // The card underneath would otherwise open the instance on the same click.
    e.preventDefault()
    e.stopPropagation()
    setDraft(value)
    setEditing(true)
  }

  async function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next !== '' && next !== value) await onSave(next)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        className={inputClassName ?? 'px-2 py-0.5 rounded-md text-sm font-medium w-full'}
        style={inputStyle ?? { background: 'var(--background)', border: '1px solid var(--accent)', color: 'var(--foreground)' }}
      />
    )
  }

  return (
    <span
      {...(trigger === 'click' ? { onClick: start } : { onDoubleClick: start })}
      {...(title !== undefined ? { title } : {})}
      className="min-w-0 cursor-text"
    >
      {children}
    </span>
  )
}
