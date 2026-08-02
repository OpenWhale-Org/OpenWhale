/**
 * Synthesize a shape-correct sample value from a JSON Schema (as produced by
 * z.toJSONSchema). Values need not be realistic — the L4 dry-run only needs
 * generated code to survive field access and type checks.
 */
export function sampleFromJsonSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return null
  const s = schema as Record<string, unknown>

  if (s['default'] !== undefined) return s['default']
  if (Array.isArray(s['enum']) && s['enum'].length > 0) return s['enum'][0]
  if (Array.isArray(s['anyOf']) && s['anyOf'].length > 0) return sampleFromJsonSchema(s['anyOf'][0])

  switch (s['type']) {
    case 'string': {
      if (typeof s['pattern'] === 'string') {
        // Common cases in this codebase; fall back to a plain string.
        if (s['pattern'].includes('0x[0-9a-fA-F]{40}')) return '0x' + '11'.repeat(20)
        if (s['pattern'].includes('0x[0-9a-fA-F]{64}')) return '0x' + '11'.repeat(32)
      }
      return 'BTC/USDC:USDC'
    }
    case 'number':
    case 'integer':
      return typeof s['minimum'] === 'number' ? Math.max(1, s['minimum'] as number) : 1
    case 'boolean':
      return false
    case 'array':
      return s['items'] ? [sampleFromJsonSchema(s['items'])] : []
    case 'object': {
      const props = (s['properties'] ?? {}) as Record<string, unknown>
      const required = new Set((s['required'] ?? []) as string[])
      const out: Record<string, unknown> = {}
      for (const [key, prop] of Object.entries(props)) {
        // Include required fields and cheap optionals alike — more fields
        // survive more access patterns.
        if (required.has(key) || (prop as Record<string, unknown>)['type'] !== undefined) {
          out[key] = sampleFromJsonSchema(prop)
        }
      }
      return out
    }
    default:
      return null
  }
}
