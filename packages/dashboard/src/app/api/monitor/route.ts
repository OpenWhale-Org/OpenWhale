import { NextResponse } from 'next/server'
import { ensureStarted } from '@/lib/runtime'

export async function GET() {
  const runtime = await ensureStarted()
  return NextResponse.json({
    monitors: runtime.listMonitors(),
    executors: runtime.listExecutors(),
  })
}
