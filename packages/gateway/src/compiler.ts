/** CompilerService singleton — one per gateway process. */
import { CompilerService } from '@openwhaleorg/compiler'
import type { DBCredentialStore, OpenWhaleRuntime } from '@openwhaleorg/core'
import { ensureStarted, getRuntime } from './runtime.js'

let compilerSingleton: CompilerService | undefined

function create(runtime: OpenWhaleRuntime): CompilerService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credentialStore = (runtime as any).credentialStore as DBCredentialStore
  return new CompilerService({
    runtime,
    credentialStore,
    compiledLoader: runtime.getCompiledLoader(),
  }, {
    ...(process.env['COMPILER_MODEL'] ? { model: process.env['COMPILER_MODEL'] } : {}),
  })
}

export function getCompilerService(): CompilerService {
  if (!compilerSingleton) compilerSingleton = create(getRuntime())
  return compilerSingleton
}

export async function ensureCompiler(): Promise<CompilerService> {
  await ensureStarted()
  return getCompilerService()
}
