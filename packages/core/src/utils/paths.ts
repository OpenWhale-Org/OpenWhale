import { homedir } from 'os'
import path from 'path'

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
