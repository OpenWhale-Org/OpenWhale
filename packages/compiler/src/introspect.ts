import { z } from 'zod'
import type { OpenWhaleRuntime } from '@openwhaleorg/core'

/**
 * Registry introspection: what the AI is told up front (snapshot) and what it
 * may read on demand (component source via constructor.toString(), which works
 * for every registered component regardless of origin — builtin, plugin, or
 * hot-compiled).
 */

export interface ComponentSnapshot {
  monitors: Array<{ id: string; name: string; description?: string; emitSchema?: unknown; keySchema?: unknown }>
  executors: Array<{
    id: string
    name: string
    description?: string
    supportedActions: string[]
    actionSchemas?: Record<string, unknown>
    credentialSlots?: unknown
  }>
  strategies: Array<{ id: string; name: string }>
  kinds: string[]
  credentialTypes: Array<{ type: string; kinds: string[] }>
}

export function snapshot(runtime: OpenWhaleRuntime): ComponentSnapshot {
  const monitors = runtime.listMonitors().map((def) => {
    const instance = runtime.getMonitorInstance(def.id)
    const emitSchema = instance?.emitSchema
    const keySchema = instance?.keySchema
    return {
      id: def.id,
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      ...(emitSchema ? { emitSchema: z.toJSONSchema(emitSchema) } : {}),
      ...(keySchema ? { keySchema: z.toJSONSchema(keySchema) } : {}),
    }
  })

  const executors = runtime.listExecutors().map((def) => {
    const instance = runtime.getExecutorInstance(def.id)
    const actionSchemas = instance?.actionSchemas
    return {
      id: def.id,
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      supportedActions: def.supportedActions,
      ...(actionSchemas
        ? { actionSchemas: Object.fromEntries(Object.entries(actionSchemas).map(([a, s]) => [a, z.toJSONSchema(s)])) }
        : {}),
      ...(instance && instance.credentials.length > 0 ? { credentialSlots: instance.credentials } : {}),
    }
  })

  return {
    monitors,
    executors,
    strategies: runtime.listStrategies().map(s => ({ id: s.id, name: s.name })),
    kinds: runtime.listKinds(),
    credentialTypes: runtime.describeCredentialTypes().map(t => ({ type: t.type, kinds: t.kinds })),
  }
}

export function readComponentSource(
  runtime: OpenWhaleRuntime,
  type: 'monitor' | 'executor',
  id: string,
): string {
  const instance = type === 'monitor' ? runtime.getMonitorInstance(id) : runtime.getExecutorInstance(id)
  if (!instance) return `ERROR: no registered ${type} with id "${id}". Use list ids exactly as given.`
  // Compiled JS of the class — perfectly readable for an LLM deciding reuse.
  return (instance.constructor as { toString(): string }).toString()
}
