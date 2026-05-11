import { NextResponse } from 'next/server'
import { ensureStarted, getRuntime } from '@/lib/runtime'
import type { DBCredentialStore } from '@openwhale/core'

function getCredentialStore(): DBCredentialStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getRuntime() as any).credentialStore as DBCredentialStore
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureStarted()
  const { id } = await params
  const store = getCredentialStore()
  await store.delete(id)
  return NextResponse.json({ ok: true })
}
