import { NextResponse } from 'next/server'
import { ensureStarted } from '@/lib/runtime'

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const runtime = await ensureStarted()
  const { id } = await params
  await runtime.deactivate(id)
  return NextResponse.json({ ok: true })
}
