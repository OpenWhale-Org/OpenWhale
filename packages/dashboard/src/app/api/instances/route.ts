import { NextResponse } from 'next/server'
import { ensureStarted } from '@/lib/runtime'
import type { StrategyInstance } from '@openwhale/core'

export async function GET() {
  const runtime = await ensureStarted()
  return NextResponse.json(runtime.listInstances())
}

export async function POST(request: Request) {
  const runtime = await ensureStarted()
  const body = (await request.json()) as StrategyInstance
  await runtime.activate(body)
  return NextResponse.json({ ok: true }, { status: 201 })
}
