/**
 * Server-side data access for server components — fetched from the GATEWAY.
 *
 * The runtime no longer lives in this process: @openwhaleorg/gateway is the
 * resident backend owning the OpenWhaleRuntime; this app is a pure frontend.
 * Client components keep calling /api/* (Next rewrites proxy them to the
 * gateway); server components fetch the gateway directly here.
 *
 * Fetch failures degrade to empty data (with a server-side log) so the UI
 * still renders when the gateway is down — the SSE status dot goes red.
 */
import { cookies } from 'next/headers'
import type { StrategyInstance, StrategyInstanceView, CredentialInfo, CredentialTypeInfo, MonitorDefinition, ExecutorDefinition, StrategyDefinition, AccountView, AccountImplementationInfo, AccountSnapshotRecord, MonitorInstanceView, LoadedPluginInfo } from '@openwhaleorg/core'
import type { AuthUser } from './auth'

export const GATEWAY_URL = process.env['OPENWHALE_GATEWAY_URL'] ?? 'http://localhost:3001'

/**
 * Server components talk to the gateway directly, so they must carry the
 * caller's session themselves — unlike client fetches, which go through the
 * Next rewrite and keep the browser's cookie automatically. Without this every
 * page would render its fallback (empty) for a logged-in user.
 */
async function gw<T>(path: string, fallback: T): Promise<T> {
  try {
    const store = await cookies()
    const cookie = store.toString()
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      cache: 'no-store',
      ...(cookie ? { headers: { cookie } } : {}),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json() as T
  } catch (err) {
    console.error(`[dashboard] gateway fetch ${path} failed:`, err instanceof Error ? err.message : err)
    return fallback
  }
}

export function fetchCurrentUser(): Promise<{ user?: AuthUser }> {
  return gw('/api/auth/me', {})
}

export function fetchUsers(): Promise<AuthUser[]> {
  return gw('/api/users', [])
}

export interface RegistryData {
  monitors: MonitorDefinition[]
  executors: ExecutorDefinition[]
  strategies: StrategyDefinition[]
}

export interface CredentialWithPublicData extends CredentialInfo {
  publicData?: Record<string, unknown>
}

/** Executor view served by /api/executor/status. */
export interface ExecutorStatusView {
  id: string
  name: string
  description?: string
  supportedActions: string[]
  credentialSlots: Array<{ label: string; kind?: string; type?: string; raw?: boolean }>
  actionSchemas?: Record<string, Record<string, unknown>>
}

/** Installed-plugin view served by /api/plugins (gateway's plugin service). */
export type PluginSource =
  | { kind: 'npm'; package: string }
  | { kind: 'github'; repo: string; ref?: string; packageName: string }
  | { kind: 'local'; path: string; packageName: string }
  | { kind: 'file'; originalName: string }

export interface InstalledPluginView extends LoadedPluginInfo {
  source?: PluginSource
  installedAt?: string
  loadError?: string
}

export function fetchInstances(): Promise<StrategyInstanceView[]> {
  return gw('/api/instances', [])
}

export function fetchCredentials(): Promise<CredentialWithPublicData[]> {
  return gw('/api/credentials', [])
}

export function fetchCredentialTypes(): Promise<CredentialTypeInfo[]> {
  return gw('/api/credential-types', [])
}

export function fetchRegistry(): Promise<RegistryData> {
  return gw('/api/registry', { monitors: [], executors: [], strategies: [] })
}

export async function fetchMonitorDefinitions(): Promise<MonitorDefinition[]> {
  return (await gw<{ monitors: MonitorDefinition[] }>('/api/monitor', { monitors: [] })).monitors
}

export function fetchAccountsData(): Promise<{ accounts: AccountView[]; implementations: AccountImplementationInfo[]; snapshots: Record<string, AccountSnapshotRecord> }> {
  return gw('/api/accounts', { accounts: [], implementations: [], snapshots: {} })
}

export function fetchMonitorInstancesData(): Promise<{ instances: MonitorInstanceView[]; implementations: Array<{ id: string; contract: string; owner: string; displayName?: string; description?: string; credential?: { type: string; level: 'optional' | 'required' }; paramsFields?: import('@openwhaleorg/core').ParamFieldDef[] }>; pendingKeys: Record<string, string[]> }> {
  return gw('/api/monitor-instances', { instances: [], implementations: [], pendingKeys: {} })
}

export function fetchExecutorStatus(): Promise<ExecutorStatusView[]> {
  return gw('/api/executor/status', [])
}

export function fetchScripts(): Promise<import('@openwhaleorg/core').ScriptInfo[]> {
  return gw('/api/scripts', [])
}

export function fetchInstalledPlugins(): Promise<InstalledPluginView[]> {
  return gw('/api/plugins', [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchCompilerJobs(): Promise<any[]> {
  return gw('/api/compiler/jobs', [])
}
