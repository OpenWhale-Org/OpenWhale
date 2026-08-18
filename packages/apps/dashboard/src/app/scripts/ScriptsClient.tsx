'use client'

import { useEffect, useRef, useState } from 'react'
import type { ScriptInfo, ParamFieldDef } from '@openwhaleorg/core'

/**
 * How the page is arranged (server-side; see the gateway's scriptShelf).
 *
 * Same model as the STRATEGY layout: a folder is a NAME carried by its
 * members plus a sortOrder, not an entity with an id. That is what lets the
 * two pages share drag-and-drop semantics exactly — drop a card on a card to
 * reorder or re-file it, drag a folder header to move the whole block.
 */
interface ScriptShelfEntry { folder?: string; sortOrder?: number; unmounted?: boolean }
interface ScriptShelf { items: Record<string, ScriptShelfEntry> }

const EMPTY_SHELF: ScriptShelf = { items: {} }

/**
 * Scripts — plugin-shipped operator utilities, run on click. One card per
 * script: a small flat param form (derived from the script's zod schema) and
 * the monospace report it returns. No lifecycle, no persistence — anything
 * recurring belongs in a monitor or strategy.
 *
 * Plugins keep adding scripts and the page grew into one long column of cards,
 * so the shelf sits on top of that: folders to group them, and unmounting to
 * put the ones you never run out of sight. UNMOUNTING IS COSMETIC — the script
 * stays registered and runnable through the API; this only decides what the
 * page shows. Nothing here can break a plugin, which is the point.
 */
export function ScriptsClient() {
  const [scripts, setScripts] = useState<ScriptInfo[] | null>(null)
  const [shelf, setShelf] = useState<ScriptShelf>(EMPTY_SHELF)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  /** The mount manager: every script by package, mounted or not. */
  const [manage, setManage] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Says where an unmounted script went — otherwise it just vanishes on click. */
  const [notice, setNotice] = useState('')
  /** Which card or folder has its grip held — native DnD has no handle concept. */
  const [armed, setArmed] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/scripts')
      .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); setScripts(await r.json() as ScriptInfo[]) })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
    // A shelf that fails to load degrades to "show everything, ungrouped" —
    // never to a blank page.
    void fetch('/api/scripts/shelf')
      .then(async r => { if (r.ok) setShelf(await r.json() as ScriptShelf) })
      .catch(() => {})
  }, [])

  /** Optimistic: the arrangement is cheap to redraw and the write is one row. */
  async function save(next: ScriptShelf) {
    setShelf(next)
    setSaveError('')
    try {
      const res = await fetch('/api/scripts/shelf', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      setSaveError(`Arrangement not saved: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Page header — same shape as the instances page: title left, actions right. */
  const header = (right?: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold">Scripts</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Plugin-shipped operator utilities, run on demand
        </p>
      </div>
      <div className="flex gap-2 shrink-0">{right}</div>
    </div>
  )

  if (error) return <div>{header()}<div className="text-sm" style={{ color: 'var(--danger)' }}>Failed to load: {error}</div></div>
  if (scripts === null) return <div>{header()}<div className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</div></div>
  if (scripts.length === 0) {
    return <div>{header()}<div className="text-sm" style={{ color: 'var(--muted)' }}>No scripts registered — plugins provide them via `scripts: [...]`.</div></div>
  }

  const entry = (id: string): ScriptShelfEntry => shelf.items[id] ?? {}
  const patch = (id: string, e: ScriptShelfEntry) =>
    ({ items: { ...shelf.items, [id]: { ...entry(id), ...e } } })

  const mounted = scripts.filter(s => !entry(s.id).unmounted)
  const groups = groupByFolder(mounted, entry)
  const folderNames = groups.map(g => g.folder).filter((f): f is string => f !== undefined)

  const setFolder = (id: string, name: string) => {
    const next = patch(id, { folder: name })
    if (!name) delete next.items[id]!.folder
    void save(next)
  }

  const setMounted = (id: string, on: boolean) => {
    const next = patch(id, { unmounted: !on })
    if (on) delete next.items[id]!.unmounted
    void save(next)
    // Bridges the two words on purpose: the control says "minimize", the
    // manager says "mounted" — the notice is where the operator learns they
    // are the same thing.
    if (!on) setNotice('Minimized — it is now unmounted. Bring it back any time from Manage.')
  }

  /** Drop a card on a card: reorder within the group, or re-file into the target's folder. */
  const dropCard = (dragId: string, targetId: string) => {
    if (dragId === targetId) return
    const next = groups.map(g => ({ ...g, items: [...g.items] }))
    const from = next.find(g => g.items.some(s => s.id === dragId))
    const to = next.find(g => g.items.some(s => s.id === targetId))
    if (!from || !to) return
    const dragged = from.items.splice(from.items.findIndex(s => s.id === dragId), 1)[0]!
    to.items.splice(to.items.findIndex(s => s.id === targetId), 0, dragged)
    void save(layout(next, shelf, to !== from ? { id: dragId, folder: to.folder } : undefined))
  }

  const dropFolder = (dragName: string, targetName: string) => {
    if (dragName === targetName) return
    const next = groups.map(g => ({ ...g, items: [...g.items] }))
    const fi = next.findIndex(g => g.folder === dragName)
    const ti = next.findIndex(g => g.folder === targetName)
    if (fi < 0 || ti < 0) return
    const [moved] = next.splice(fi, 1)
    next.splice(ti, 0, moved!)
    void save(layout(next, shelf))
  }

  if (manage) {
    return (
      <div>
        {header(
          <button onClick={() => { setManage(false); setNotice('') }} className="btn btn-primary">
            Done
          </button>,
        )}
        <MountManager
          scripts={scripts}
          isMounted={(id) => !entry(id).unmounted}
          onToggle={setMounted}
          error={saveError}
        />
      </div>
    )
  }

  return (
    <div>
      {header(
        <button
          onClick={() => { setManage(true); setNotice('') }}
          className="btn btn-primary"
          title="Mount or unmount scripts, by package"
        >
          Manage
        </button>,
      )}
      <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
          {mounted.length} of {scripts.length} mounted · drag the ⠿ grip to reorder or re-file
        </span>
      </div>

      {notice && (
        <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-md" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
          {notice}
          <button onClick={() => { setManage(true); setNotice('') }} className="px-2 py-0.5 rounded" style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}>
            Open Manage
          </button>
          <button onClick={() => setNotice('')} className="ml-auto" style={{ color: 'var(--muted)' }}>✕</button>
        </div>
      )}

      {saveError && <div className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{saveError}</div>}

      {groups.map(({ folder, items }) => (
        <div key={folder ?? '·'} className="flex flex-col gap-3">
          {folder !== undefined && (
            <div
              draggable={armed === `folder:${folder}`}
              onDragEnd={() => setArmed(null)}
              onDragStart={(e) => {
                if (armed !== `folder:${folder}`) { e.preventDefault(); return }
                e.dataTransfer.setData('ow/sfolder', folder)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('ow/sfolder')) e.preventDefault() }}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData('ow/sfolder')
                if (dragged) { e.preventDefault(); dropFolder(dragged, folder) }
              }}
              className="flex items-center gap-2 mt-2 select-none"
            >
              <button
                className="flex items-center gap-2 text-left text-sm font-medium"
                style={{ color: 'var(--foreground)' }}
                onClick={() => setCollapsed(prev => {
                  const next = new Set(prev)
                  if (!next.delete(folder)) next.add(folder)
                  return next
                })}
              >
                <span>{collapsed.has(folder) ? '▸' : '▾'}</span>
                <span>📁 {folder}</span>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>({items.length})</span>
              </button>
              <span
                onPointerDown={() => setArmed(`folder:${folder}`)}
                className="text-xs cursor-grab select-none px-0.5"
                style={{ color: 'var(--muted)' }}
                title="Drag to reorder folders"
                aria-hidden
              >⠿</span>
            </div>
          )}
          {folder === undefined && groups.length > 1 && (
            <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Ungrouped</div>
          )}
          {(folder === undefined || !collapsed.has(folder)) && items.map((s) => (
            <div
              key={s.id}
              /* Draggable ONLY while the grip is held.
                 The wrapper used to be draggable outright, which made the whole
                 card a drag surface — on a card that is mostly a form, every
                 press felt like it might pick the card up. Native drag-and-drop
                 has no notion of a handle, so the flag is armed on pointerdown
                 over the grip and disarmed when the drag ends. The Strategies
                 page reaches the same result through pointer events; both pages
                 end up with one grabbable spot, which is the point. */
              draggable={armed === s.id}
              onDragEnd={() => setArmed(null)}
              onDragStart={(e) => {
                if (armed !== s.id) { e.preventDefault(); return }
                e.dataTransfer.setData('ow/scard', s.id)
                e.dataTransfer.effectAllowed = 'move'
                // Carry the card, not the glyph — the grip alone is a useless ghost
                const card = (e.currentTarget as HTMLElement).firstElementChild
                if (card) e.dataTransfer.setDragImage(card as Element, 24, 24)
              }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('ow/scard')) e.preventDefault() }}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData('ow/scard')
                if (dragged) { e.preventDefault(); dropCard(dragged, s.id) }
              }}
            >
              <ScriptCard
                script={s}
                folder={entry(s.id).folder}
                folders={folderNames}
                onGrip={() => setArmed(s.id)}
                onSetFolder={(name) => setFolder(s.id, name)}
                onUnmount={() => setMounted(s.id, false)}
              />
            </div>
          ))}
        </div>
      ))}
      </div>
    </div>
  )
}

/** Folder groups: FOLDERS first (ordered by min sortOrder), ungrouped last; items by sortOrder then id. */
function groupByFolder(
  scripts: ScriptInfo[],
  entry: (id: string) => ScriptShelfEntry,
): Array<{ folder: string | undefined; items: ScriptInfo[] }> {
  const byKey = new Map<string | undefined, ScriptInfo[]>()
  for (const s of scripts) {
    const key = entry(s.id).folder || undefined
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(s)
  }
  const order = (s: ScriptInfo) => entry(s.id).sortOrder ?? Number.MAX_SAFE_INTEGER
  const sortItems = (xs: ScriptInfo[]) => [...xs].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))
  const minOrder = (xs: ScriptInfo[]) => Math.min(...xs.map(order))
  const folders = [...byKey.keys()].filter((k): k is string => k !== undefined)
    .sort((a, b) => minOrder(byKey.get(a)!) - minOrder(byKey.get(b)!) || a.localeCompare(b))
  const out: Array<{ folder: string | undefined; items: ScriptInfo[] }> = []
  for (const f of folders) out.push({ folder: f, items: sortItems(byKey.get(f)!) })
  if (byKey.has(undefined)) out.push({ folder: undefined, items: sortItems(byKey.get(undefined)!) })
  return out
}

/**
 * Rewrite the FULL layout after a drag: folder blocks get contiguous
 * sortOrder bands (folderIdx×1000 + position×10, ungrouped last), so folder
 * order derives stably from min member order and every drop is durable.
 * `moved` re-files the dragged script, which the group arrays cannot express
 * on their own — they carry position, not membership.
 */
function layout(
  groups: Array<{ folder: string | undefined; items: ScriptInfo[] }>,
  shelf: ScriptShelf,
  moved?: { id: string; folder: string | undefined },
): ScriptShelf {
  const items: Record<string, ScriptShelfEntry> = { ...shelf.items }
  groups.forEach((g, gi) => {
    g.items.forEach((s, i) => {
      const prev = items[s.id] ?? {}
      const next: ScriptShelfEntry = { ...prev, sortOrder: gi * 1000 + i * 10 }
      if (g.folder) next.folder = g.folder
      else delete next.folder
      items[s.id] = next
    })
  })
  if (moved) {
    const e = { ...(items[moved.id] ?? {}) }
    if (moved.folder) e.folder = moved.folder
    else delete e.folder
    items[moved.id] = e
  }
  return { items }
}

/**
 * The mount manager — every registered script, grouped by the PACKAGE that
 * ships it. Package is the axis that matters here: you mount and unmount by
 * where something came from ("I don't use the pair-arb tools"), while folders
 * are the arrangement you build by hand on the page itself.
 */
function MountManager({ scripts, isMounted, onToggle, error }: {
  scripts: ScriptInfo[]
  isMounted: (id: string) => boolean
  onToggle: (id: string, on: boolean) => void
  error: string
}) {
  const byPackage = new Map<string, ScriptInfo[]>()
  for (const s of [...scripts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!byPackage.has(s.pluginName)) byPackage.set(s.pluginName, [])
    byPackage.get(s.pluginName)!.push(s)
  }
  const mountedCount = scripts.filter(s => isMounted(s.id)).length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
          {mountedCount} of {scripts.length} mounted · unmounting only hides it from the page
        </span>
      </div>

      {error && <div className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</div>}

      {[...byPackage.entries()].map(([pkg, items]) => (
        <section key={pkg} className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 px-3 py-2 text-xs" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
            <span className="font-semibold uppercase">{pkg}</span>
            <span>{items.filter(s => isMounted(s.id)).length}/{items.length}</span>
            <button
              onClick={() => {
                const allOn = items.every(s => isMounted(s.id))
                for (const s of items) onToggle(s.id, !allOn)
              }}
              className="ml-auto px-2 py-0.5 rounded"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
            >
              {items.every(s => isMounted(s.id)) ? 'Unmount all' : 'Mount all'}
            </button>
          </div>
          {items.map((s, i) => {
            const on = isMounted(s.id)
            return (
              <div
                key={s.id}
                className="flex items-center gap-3 px-3 py-2"
                style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)', opacity: on ? 1 : 0.55 }}
              >
                <button
                  onClick={() => onToggle(s.id, !on)}
                  className="text-xs shrink-0"
                  style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}
                  title={on ? 'Unmount — hide it from the page' : 'Mount — show it on the page'}
                >
                  {on ? '☑' : '☐'}
                </button>
                <div className="min-w-0">
                  <div className="text-sm">{s.name}</div>
                  <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>
                    {s.id}{s.description ? ` — ${s.description}` : ''}
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/**
 * Folder picker, same shape as the strategy list's: pick an existing folder,
 * type a new one, or drop out of the folder entirely.
 */
function FolderMenu({ current, folders, onPick }: {
  current?: string
  folders: string[]
  onPick: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const pick = (name: string) => { onPick(name); setOpen(false); setDraft('') }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="px-2 py-1.5 rounded-md text-xs"
        title="Move to a folder"
        style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
      >
        📁{current ? ` ${current}` : ''}
      </button>
      {open && (
        <div
          className="absolute right-0 z-[100] mt-1 rounded-md shadow-lg flex flex-col"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '11rem', maxHeight: '16rem' }}
        >
          <div className="overflow-y-auto">
            {folders.map(f => (
              <button
                key={f}
                type="button"
                onClick={() => pick(f)}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
                style={{ color: 'var(--foreground)' }}
              >
                <span style={{ color: f === current ? 'var(--accent)' : 'var(--muted)' }}>{f === current ? '●' : '○'}</span>
                📁 {f}
              </button>
            ))}
          </div>
          <form
            className="flex gap-1 px-2 py-2"
            style={{ borderTop: folders.length ? '1px solid var(--border)' : 'none' }}
            onSubmit={(e) => { e.preventDefault(); if (draft.trim()) pick(draft.trim()) }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="New folder…"
              className="flex-1 min-w-0 rounded px-2 py-1 text-xs"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            />
            <button type="submit" className="text-xs px-2 rounded" style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}>Add</button>
          </form>
          {current && (
            <button
              type="button"
              onClick={() => pick('')}
              className="text-left px-3 py-1.5 text-xs"
              style={{ color: 'var(--danger)', borderTop: '1px solid var(--border)' }}
            >
              Remove from folder
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** An attachment a script returned alongside its report. */
interface ScriptFile { name: string; mime?: string; content: string }
interface ScriptOutput { text: string; json?: unknown; files?: ScriptFile[] }

const sizeLabel = (s: string): string => {
  const kb = new Blob([s]).size / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`
}

/**
 * Open the attachment in its own tab.
 *
 * A blob: URL inherits this origin, so the page opens with the dashboard's
 * privileges — acceptable only because these reports are generated by trusted
 * plugin code server-side and carry no scripts. The inline preview below is
 * stricter (sandboxed iframe, scripting off) because that one renders inside
 * the dashboard's own document.
 */
function openFile(file: ScriptFile): void {
  const blob = new Blob([file.content], { type: file.mime ?? 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Hand the file to the browser from memory — the script never wrote it to the
 * server, so there is no URL to link and nothing left behind after the save.
 */
function downloadFile(file: ScriptFile): void {
  const blob = new Blob([file.content], { type: file.mime ?? 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking in the same tick cancels the save in Safari — the download reads
  // the blob asynchronously after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * Seed the form from what the field ALREADY shows.
 *
 * A `<select>` with no value renders its first option, so the form looked
 * filled in while the state behind it was empty and the run submitted
 * `undefined` — the field displayed one thing and sent another. Defaults do
 * the same for text fields: a script author who set `.default()` expects that
 * value to be sent without the user retyping it.
 */
function seedValues(fields: ScriptInfo['paramsFields']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields ?? []) {
    // A multi-select starts empty on purpose — seeding it with the first
    // option would silently pick one item out of a list the user came here
    // to choose from, and "none selected" is a meaningful state for it.
    if (f.multiple) continue
    if (f.default !== undefined) out[f.name] = String(f.default)
    else if (f.type === 'options' && f.options?.[0] !== undefined) out[f.name] = String(f.options[0].value)
    else if (f.type === 'boolean') out[f.name] = 'false'
  }
  return out
}

function ScriptCard({ script, folder, folders, onGrip, onSetFolder, onUnmount }: {
  script: ScriptInfo
  folder?: string
  folders?: string[]
  /** Arms the wrapper's draggable flag. Fired by the grip, nowhere else. */
  onGrip?: (e: React.PointerEvent) => void
  onSetFolder?: (name: string) => void
  onUnmount?: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() => seedValues(script.paramsFields))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ScriptOutput | null>(null)
  const [runError, setRunError] = useState('')
  const [view, setView] = useState<'report' | 'html' | 'json'>('report')
  const [ranAt, setRanAt] = useState<Date | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const fields = script.paramsFields ?? []
  const htmlFile = result?.files?.find(f => (f.mime ?? '').includes('html') || f.name.endsWith('.html'))

  // A rerun can take away the view you were on (HTML off, or a script that
  // returns no attachment). Falling back beats rendering an empty panel.
  useEffect(() => {
    if (view === 'html' && !htmlFile) setView('report')
    if (view === 'json' && result?.json === undefined) setView('report')
  }, [view, htmlFile, result])

  // paramOptions resolves server-side on every listing, so the option list can
  // arrive after the first render. Re-seed the fields that are still empty —
  // never overwrite something the user has already touched.
  useEffect(() => {
    setValues(prev => {
      const seeded = seedValues(script.paramsFields)
      const next = { ...prev }
      let changed = false
      for (const [k, v] of Object.entries(seeded)) {
        if (next[k] === undefined || next[k] === '') { next[k] = v; changed = true }
      }
      return changed ? next : prev
    })
  }, [script.paramsFields])

  async function run() {
    setRunning(true)
    setRunError('')
    try {
      const params: Record<string, unknown> = {}
      for (const f of fields) {
        const raw = values[f.name]
        if (raw === undefined || raw === '') continue
        params[f.name] = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw
      }
      const [owner, ...rest] = script.id.split('/')
      const base = `/api/scripts/${encodeURIComponent(owner!)}/${encodeURIComponent(rest.join('/'))}`
      const post = (path: string) => fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params }),
      })

      // Stream by default. /api is proxied through Next, which severs an idle
      // connection at 30s, so a script that only spoke at the end returned a
      // bare "Internal Server Error" however well it had run. Streaming keeps
      // bytes moving and shows the run as it happens.
      const res = await post('/stream')
      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const lines: string[] = []
        let done: ScriptOutput | undefined
        let failed: string | undefined
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          // Frames are newline-delimited; a chunk can split one in half, so the
          // trailing partial stays in the buffer until its newline arrives.
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            if (!part.trim()) continue
            let frame: { type?: string; text?: string; json?: unknown; files?: ScriptFile[]; error?: string }
            try { frame = JSON.parse(part) } catch { continue }
            if (frame.type === 'line') { lines.push(frame.text ?? ''); setResult({ text: lines.join('\n') }) }
            else if (frame.type === 'result') done = { text: frame.text ?? '', ...(frame.json !== undefined ? { json: frame.json } : {}), ...(frame.files?.length ? { files: frame.files } : {}) }
            else if (frame.type === 'error') failed = frame.error ?? 'script failed'
          }
        }
        if (failed !== undefined) throw new Error(failed)
        // No terminal frame means the connection died mid-run. Keep whatever
        // was streamed — it is the only record of what actually happened.
        if (done === undefined) throw new Error('connection closed before the script finished')
        setResult(done)
        setRanAt(new Date())
      } else {
        // Older gateway without the streaming route.
        const legacy = await post('/run')
        const body = await legacy.json() as { text?: string; json?: unknown; files?: ScriptFile[]; error?: string }
        if (!legacy.ok) throw new Error(body.error ?? `HTTP ${legacy.status}`)
        setResult({ text: body.text ?? '', ...(body.json !== undefined ? { json: body.json } : {}), ...(body.files?.length ? { files: body.files } : {}) })
        setRanAt(new Date())
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex items-start gap-2">
          {/* The only grabbable spot on the card. */}
          {onSetFolder && (
            <span
              onPointerDown={onGrip}
              className="text-xs mt-0.5 cursor-grab select-none px-0.5"
              style={{ color: 'var(--muted)' }}
              title="Drag to reorder or move between folders"
              aria-hidden
            >⠿</span>
          )}
          <div className="min-w-0">
            <div className="font-medium">{script.name}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              {script.id}
              {script.description && <> — {script.description}</>}
            </div>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {onSetFolder && <FolderMenu {...(folder !== undefined ? { current: folder } : {})} folders={folders ?? []} onPick={onSetFolder} />}
          <button
            onClick={() => void run()}
            disabled={running}
            className="px-4 py-1.5 rounded-md text-sm"
            style={{ background: running ? 'var(--border)' : 'var(--accent)', color: '#fff' }}
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
          {/* Window-style minimize, in the corner where one belongs. Reads as
              "put this away", which is what it does — the script stays
              registered and comes back from Manage. */}
          {onUnmount && (
            <button
              onClick={onUnmount}
              className="w-6 h-6 rounded-md flex items-center justify-center leading-none"
              style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)' }}
              title="Minimize — take it off this page; restore it from Manage"
              aria-label="Minimize this script"
            >
              —
            </button>
          )}
        </div>
      </div>

      {fields.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-3">
          {fields.map(f => <FieldInput key={f.name} field={f} value={values[f.name] ?? ''} onChange={v => setValues(prev => ({ ...prev, [f.name]: v }))} />)}
        </div>
      )}

      {runError && <div className="text-xs mt-3" style={{ color: 'var(--danger)' }}>{runError}</div>}

      {result && (
        <div className="mt-3">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              Output{ranAt ? ` · ${ranAt.toLocaleTimeString()}` : ''}
            </span>
            <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {(['report', ...(htmlFile ? ['html'] as const : []), ...(result.json !== undefined ? ['json'] as const : [])] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className="text-xs px-2 py-0.5"
                  style={{
                    background: view === v ? 'var(--accent)' : 'transparent',
                    color: view === v ? '#fff' : 'var(--muted)',
                  }}
                >
                  {v === 'report' ? 'Report' : v === 'html' ? 'HTML' : 'JSON'}
                </button>
              ))}
            </div>
            {result.files?.map(f => (
              <span key={f.name} className="flex items-center gap-1">
                <button
                  onClick={() => openFile(f)}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}
                  title={`${f.name} · ${f.mime ?? 'text/plain'} · ${sizeLabel(f.content)}`}
                >
                  ↗ Open
                </button>
                <button
                  onClick={() => downloadFile(f)}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                  title={`Save ${f.name} (${sizeLabel(f.content)})`}
                >
                  ⤓
                </button>
              </span>
            ))}
            <button
              onClick={async () => {
                // Copy what is on screen, not always the report: whichever view
                // is up is what the reader means by "this".
                const shown = view === 'json' && result.json !== undefined
                  ? JSON.stringify(result.json, null, 2)
                  : view === 'html' && htmlFile
                    ? htmlFile.content
                    : result.text
                try {
                  await navigator.clipboard.writeText(shown)
                } catch {
                  // Clipboard needs a secure context; fall back so the button
                  // is never a dead end on plain http.
                  const ta = document.createElement('textarea')
                  ta.value = shown
                  ta.style.position = 'fixed'
                  ta.style.opacity = '0'
                  document.body.appendChild(ta)
                  ta.select()
                  document.execCommand('copy')
                  document.body.removeChild(ta)
                }
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="text-xs px-2 py-0.5 rounded"
              style={{ border: '1px solid var(--border)', color: copied ? 'var(--foreground)' : 'var(--muted)' }}
            >
              {copied ? '✓ Copied' : '⧉ Copy'}
            </button>
            <button onClick={() => setExpanded(v => !v)} className="text-xs px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
              {expanded ? '⤡ Collapse' : '⤢ Expand all'}
            </button>
            {!expanded && <span className="text-xs" style={{ color: 'var(--muted)' }}>(drag the corner to resize)</span>}
          </div>
          {view === 'html' && htmlFile ? (
            /*
             * `allow-scripts` WITHOUT `allow-same-origin`: the report's own
             * interactivity (hiding a series, jumping to a section) runs, but
             * the document sits in an opaque origin — it cannot reach this
             * page's DOM, cookies, or storage, and cannot navigate the top
             * frame. That pairing is what makes running the script safe; adding
             * `allow-same-origin` alongside it would hand the report this
             * origin and undo the sandbox entirely.
             */
            <iframe
              title={htmlFile.name}
              srcDoc={htmlFile.content}
              sandbox="allow-scripts"
              className="w-full rounded-md"
              style={{
                background: 'var(--background)', border: '1px solid var(--border)',
                ...(expanded ? { height: '80vh' } : { height: 480, minHeight: 160, resize: 'vertical' as const }),
              }}
            />
          ) : (
            <pre
              className="text-xs p-3 rounded-md whitespace-pre-wrap"
              style={{
                background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)',
                overflow: 'auto',
                // Free-form: expanded shows everything; collapsed starts at 480px
                // with a native drag handle (resize needs a height, not a max).
                ...(expanded ? {} : { height: 480, minHeight: 160, resize: 'vertical' as const }),
              }}
            >
              {view === 'json' && result.json !== undefined ? JSON.stringify(result.json, null, 2) : result.text}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Checkbox list for a field declaring `multiple` — stored comma-separated, the
 * same wire format Instances already uses, so a script reads one string and
 * splits it.
 *
 * A native <select multiple> was the obvious choice and the wrong one: it
 * shows three rows, needs ctrl-click to add without clearing the rest, and
 * gives no count. Picking several settlements is the whole point of the
 * field, so the control has to make picking several the easy path.
 */
function MultiSelect({ options, value, onChange }: {
  options: NonNullable<ParamFieldDef['options']>
  value: string
  onChange: (v: string) => void
}) {
  const chosen = value ? value.split(',').filter(Boolean) : []
  const toggle = (v: string) => {
    const next = chosen.includes(v) ? chosen.filter(x => x !== v) : [...chosen, v]
    onChange(next.join(','))
  }
  return (
    <div className="rounded-md" style={{ background: 'var(--background)', border: '1px solid var(--border)', minWidth: '22rem' }}>
      <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {chosen.length === 0 ? 'none selected — script picks its default' : `${chosen.length} selected`}
        </span>
        {chosen.length > 0 && (
          <button type="button" onClick={() => onChange('')} className="text-xs px-1.5 py-0.5 rounded" style={{ color: 'var(--muted)' }}>
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-col overflow-y-auto" style={{ maxHeight: '11rem' }}>
        {options.map(o => {
          const v = String(o.value)
          const on = chosen.includes(v)
          return (
            <button
              key={v}
              type="button"
              onClick={() => toggle(v)}
              className="flex items-start gap-2 text-left text-xs px-2 py-1 font-mono"
              style={{ background: on ? 'var(--surface)' : 'transparent', color: 'var(--foreground)' }}
            >
              <span style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}>{on ? '☑' : '☐'}</span>
              <span className="min-w-0">{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FieldInput({ field, value, onChange }: { field: ParamFieldDef; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }}>
      <span>
        {field.displayName ?? field.name}
        {field.description && <span title={field.description}> ⓘ</span>}
      </span>
      {field.multiple && field.options ? (
        <MultiSelect options={field.options} value={value} onChange={onChange} />
      ) : field.type === 'options' && field.options ? (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="rounded-md px-2 py-1.5 text-sm font-mono"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', minWidth: '16rem' }}
        >
          {field.options.map(o => (
            <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <select
          value={value || 'false'}
          onChange={e => onChange(e.target.value)}
          className="rounded-md px-2 py-1.5 text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
          className="rounded-md px-2 py-1.5 text-sm font-mono"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', minWidth: '16rem' }}
        />
      )}
    </label>
  )
}
