import { NextResponse } from 'next/server'
import { ensureStarted } from '@/lib/runtime'
import { getRuntime } from '@/lib/runtime'
import type { DBCredentialStore } from '@openwhale/core'

function getCredentialStore(): DBCredentialStore {
  // credentialStore is private on OpenWhaleRuntime; we cast to access it for the dashboard
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getRuntime() as any).credentialStore as DBCredentialStore
}

export async function GET() {
  await ensureStarted()
  const store = getCredentialStore()
  const list = await store.list()
  return NextResponse.json(list)
}

export async function POST(request: Request) {
  await ensureStarted()
  const store = getCredentialStore()
  const body = (await request.json()) as { name: string; type: string; data: Record<string, unknown> }
  const info = await store.set(body.name, body.type, body.data)
  return NextResponse.json(info, { status: 201 })
}
