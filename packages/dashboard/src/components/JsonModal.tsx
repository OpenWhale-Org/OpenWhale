'use client'

import { useState } from 'react'

/** One-click copy with transient feedback. Copies pretty JSON for objects, raw text otherwise. */
export function CopyButton({ value, label }: { value: unknown; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
      title="Copy JSON"
      className="text-xs px-1.5 py-0.5 rounded shrink-0"
      style={{
        color: copied ? '#4ade80' : 'var(--muted)',
        border: '1px solid var(--border)',
        background: 'transparent',
      }}
    >
      {copied ? '✓ copied' : label ?? '⧉'}
    </button>
  )
}

/** Fullscreen-overlay JSON viewer with copy. */
export function JsonModal({ title, data, onClose }: { title: string; data: unknown; onClose: () => void }) {
  const text = JSON.stringify(data, null, 2)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={onClose}
    >
      <div
        className="rounded-lg flex flex-col w-full max-w-3xl max-h-[80vh] overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: 'var(--background)', borderBottom: '1px solid var(--border)' }}>
          <span className="text-sm font-mono font-medium flex-1 truncate">{title}</span>
          <CopyButton value={text} label="copy JSON" />
          <button onClick={onClose} className="text-sm px-2" style={{ color: 'var(--muted)' }}>✕</button>
        </div>
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono whitespace-pre" style={{ color: 'var(--foreground)' }}>
          {text}
        </pre>
      </div>
    </div>
  )
}
