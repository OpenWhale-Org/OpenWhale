import { homedir } from 'os'
import path from 'path'

/**
 * ~/.openwhale/
 * ├── credentials.jsonl                          — encrypted credential store
 * ├── monitors/                                  — monitor collected data
 * │   └── {monitorName}/
 * │       └── {key}.jsonl
 * ├── executions/                                — executor execution records
 * │   └── {executorName}/
 * │       └── {YYYY-MM-DD}.jsonl
 * ├── registry/                                  — metadata index for AI-compiled artifacts
 * │   ├── monitors/{id}.json
 * │   ├── executors/{id}.json
 * │   └── strategies/{id}.json
 * ├── compiled/                                  — AI-compiled artifact code
 * │   ├── monitors/{id}/source.ts + index.js
 * │   ├── executors/{id}/source.ts + index.js
 * │   └── strategies/{id}/source.ts + index.js
 * └── instances/                                 — StrategyInstance runtime config
 *     └── {id}.json
 */

export function getDataDir(custom?: string): string {
  return custom ?? path.join(homedir(), '.openwhale')
}

export function getMonitorPath(dataDir: string, monitorName: string, key: string): string {
  return path.join(dataDir, 'monitors', monitorName, `${key}.jsonl`)
}

export function getExecutionPath(dataDir: string, executorName: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(dataDir, 'executions', executorName, `${date}.jsonl`)
}

export function getCredentialPath(dataDir: string): string {
  return path.join(dataDir, 'credentials.jsonl')
}

export function getRegistryPath(dataDir: string, type: string, id: string): string {
  return path.join(dataDir, 'registry', type, `${id}.json`)
}

export function getCompiledSourcePath(dataDir: string, type: string, id: string): string {
  return path.join(dataDir, 'compiled', type, id, 'source.ts')
}

export function getCompiledOutputPath(dataDir: string, type: string, id: string): string {
  return path.join(dataDir, 'compiled', type, id, 'index.js')
}

export function getInstancePath(dataDir: string, id: string): string {
  return path.join(dataDir, 'instances', `${id}.json`)
}
