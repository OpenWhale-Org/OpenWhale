import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Lower ES decorators (@Ow* component metadata) — the default 'esnext'
  // target keeps them as-is, which Node cannot parse yet.
  esbuild: { target: 'es2022' },
  test: {
    environment: 'node',
  },
})
