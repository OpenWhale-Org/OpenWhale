import { NextResponse } from 'next/server'
import { ensureStarted, getRuntime } from '@/lib/runtime'
import type { CompiledLoader, CompiledType } from '@openwhale/core'
import fs from 'fs'
import path from 'path'
import os from 'os'

function getLoader(): CompiledLoader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getRuntime() as any).compiledLoader as CompiledLoader
}

function getDataDir(): string {
  return process.env['OPENWHALE_DB_PATH']
    ? path.dirname(process.env['OPENWHALE_DB_PATH'])
    : path.join(os.homedir(), '.openwhale')
}

export async function GET() {
  const runtime = await ensureStarted()
  return NextResponse.json({
    monitors: runtime.listMonitors(),
    executors: runtime.listExecutors(),
    strategies: runtime.listStrategies(),
  })
}

/**
 * POST /api/registry
 * Body: multipart/form-data with fields:
 *   - type: 'monitors' | 'executors' | 'strategies'
 *   - id: string
 *   - file: .ts source file
 */
export async function POST(request: Request) {
  await ensureStarted()

  const formData = await request.formData()
  const type = formData.get('type') as CompiledType | null
  const id = formData.get('id') as string | null
  const file = formData.get('file') as File | null

  if (!type || !['monitors', 'executors', 'strategies'].includes(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  }
  if (!id || !/^[a-z0-9-_]+$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid id (alphanumeric, hyphens, underscores only)' }, { status: 400 })
  }
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const dataDir = getDataDir()
  const sourceDir = path.join(dataDir, 'compiled', type, id)
  const sourcePath = path.join(sourceDir, 'source.ts')

  await fs.promises.mkdir(sourceDir, { recursive: true })
  const content = await file.text()
  await fs.promises.writeFile(sourcePath, content, 'utf8')

  const loader = getLoader()
  await loader.recompile(id, type)

  return NextResponse.json({ ok: true, id, type }, { status: 201 })
}
