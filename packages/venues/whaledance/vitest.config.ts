import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { target: 'es2022' },
  test: { environment: 'node' },
})
