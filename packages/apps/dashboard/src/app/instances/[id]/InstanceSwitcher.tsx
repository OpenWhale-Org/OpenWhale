'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { StrategyInstanceView } from '@openwhaleorg/core'
import { Select } from '@/components/Select'
import { useUnsavedLabels } from '@/components/unsaved'
import { useT } from '@/i18n'

/**
 * Jump from one instance's board straight to another's, without the trip back
 * through the list. Running instances first, then the rest, each group in the
 * list page's own order; the search box appears once the list is long.
 *
 * The shell's unsaved-changes guard only catches link clicks, and this is a
 * router push — so it asks the same question itself before leaving edited
 * parameters behind.
 */
export function InstanceSwitcher({ currentId }: { currentId: string }) {
  const t = useT()
  const router = useRouter()
  const unsaved = useUnsavedLabels()
  const [instances, setInstances] = useState<StrategyInstanceView[]>([])

  useEffect(() => {
    let gone = false
    void fetch('/api/instances').then(async (res) => {
      if (!res.ok || gone) return
      const list = await res.json() as StrategyInstanceView[]
      if (!gone) setInstances(list)
    }).catch(() => { /* the switcher simply stays empty */ })
    return () => { gone = true }
  }, [])

  if (instances.length < 2) return null
  const ordered = [...instances].sort((a, b) =>
    Number(b.active) - Number(a.active)
    || (a.folder ?? '').localeCompare(b.folder ?? '')
    || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    || a.name.localeCompare(b.name))

  return (
    <Select
      size="sm"
      value={currentId}
      searchable
      style={{ minWidth: '14rem', maxWidth: '22rem' }}
      options={ordered.map(i => ({
        value: i.id,
        label: <span className="inline-flex items-center gap-1.5">
          <span style={{ color: i.active ? 'var(--success, #22c55e)' : 'var(--muted)' }}>●</span>
          <span>{i.icon ? `${i.icon} ` : ''}{i.name}</span>
        </span>,
        search: `${i.name} ${i.id} ${i.strategyId}`,
        hint: `${i.strategyId.split('/').pop()}${i.folder ? ` · ${i.folder}` : ''}`,
      }))}
      onChange={(id) => {
        if (id === currentId) return
        if (unsaved.length > 0 && !window.confirm(t('board.switchUnsaved', { what: unsaved.join('、') }))) return
        router.push(`/instances/${encodeURIComponent(id)}`)
      }}
    />
  )
}
