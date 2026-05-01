import { homedir } from 'os'
import path from 'path'

/**
 * ~/.openwhale/
 * ├── credentials.jsonl                          — 加密凭证存储
 * ├── monitors/                                  — Monitor 采集数据
 * │   └── {monitorName}/
 * │       └── {key}.jsonl
 * ├── executions/                                — Executor 执行记录
 * │   └── {executorName}/
 * │       └── {YYYY-MM-DD}.jsonl
 * ├── registry/                                  — AI 编译产物的元数据索引
 * │   ├── monitors/{id}.json
 * │   ├── executors/{id}.json
 * │   └── strategies/{id}.json
 * ├── compiled/                                  — AI 编译产物代码
 * │   ├── monitors/{id}/source.ts + index.js
 * │   ├── executors/{id}/source.ts + index.js
 * │   └── strategies/{id}/source.ts + index.js
 * └── bundles/                                   — StrategyBundle 运行时配置
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

export function getBundlePath(dataDir: string, id: string): string {
  return path.join(dataDir, 'bundles', `${id}.json`)
}
