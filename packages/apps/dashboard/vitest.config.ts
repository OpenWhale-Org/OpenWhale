import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Next resolves `@/…` from tsconfig's paths; vitest does not read tsconfig.
 * Without this, the first unit test that reaches a component importing
 * `@/i18n` fails to load with "Does the file exist?" — which is exactly what
 * happened when SeriesChart gained a translation hook.
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
})
