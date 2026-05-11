import { NextResponse } from 'next/server'
import { ensureStarted } from '@/lib/runtime'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string; key: string }> },
) {
  const runtime = await ensureStarted()
  const { name, key } = await params
  const monitor = runtime.getMonitor(name)
  if (!monitor) {
    return NextResponse.json({ error: `Monitor not found: ${name}` }, { status: 404 })
  }
  const reader = monitor.getReader()
  const records = await reader.readLast(key, 50)
  return NextResponse.json(records)
}
