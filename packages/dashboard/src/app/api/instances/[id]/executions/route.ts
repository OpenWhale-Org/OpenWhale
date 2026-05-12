import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'

export const dynamic = 'force-dynamic'

function getDataDir(): string {
  return process.env['OPENWHALE_DB_PATH']
    ? path.dirname(process.env['OPENWHALE_DB_PATH'])
    : path.join(os.homedir(), '.openwhale')
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: instanceId } = await params
  const dataDir = getDataDir()
  const executionsDir = path.join(dataDir, 'executions')
  const results: unknown[] = []

  try {
    const executorDirs = await fs.promises.readdir(executionsDir)
    const today = new Date().toISOString().slice(0, 10)

    await Promise.all(
      executorDirs.map(async (executorName) => {
        const filePath = path.join(executionsDir, executorName, `${today}.jsonl`)
        try {
          const content = await fs.promises.readFile(filePath, 'utf8')
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
              const record = JSON.parse(line) as { instruction?: { instanceId?: string } }
              if (record.instruction?.instanceId === instanceId) {
                results.push(record)
              }
            } catch { /* skip malformed lines */ }
          }
        } catch { /* file may not exist yet */ }
      })
    )
  } catch { /* executions dir may not exist yet */ }

  // Sort by executedAt descending
  results.sort((a, b) => {
    const ta = new Date((a as { executedAt: string }).executedAt).getTime()
    const tb = new Date((b as { executedAt: string }).executedAt).getTime()
    return tb - ta
  })

  return NextResponse.json(results)
}
