import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import * as esbuild from 'esbuild'
import ts from 'typescript'
import type { OpenWhaleRuntime, IStrategy, StrategyContext, ExecutionInstruction, IStrategyStore } from '@openwhaleorg/core'
import { HttpClient } from '@openwhaleorg/core'
import { z } from 'zod'
import { sampleFromJsonSchema } from './mockData.js'
import type { DraftFile, ValidationIssue, ValidationReport } from './types.js'

/** Bare imports generated code may use. Anything else fails validation. */
const IMPORT_ALLOWLIST = new Set(['@openwhaleorg/core', '@openwhaleorg/exchange', 'zod'])

const hostRequire = createRequire(path.join(process.cwd(), 'package.json'))
const selfRequire = createRequire(import.meta.url)

function resolvePackageRoot(pkg: string): string | undefined {
  for (const req of [hostRequire, selfRequire]) {
    try {
      let dir = path.dirname(req.resolve(pkg))
      while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
        dir = path.dirname(dir)
      }
    } catch { /* try next resolver */ }
  }
  return undefined
}

function bareImports(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) {
    const spec = m[1]!
    if (spec.startsWith('node:')) continue
    out.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)
  }
  return [...out]
}

/**
 * Write draft files into workDir and symlink their dependencies into a local
 * node_modules — one mechanism that makes tsc, esbuild, and dynamic import()
 * all resolve naturally from a directory outside the workspace.
 */
function prepareWorkDir(workDir: string, files: DraftFile[], issues: ValidationIssue[]): Map<DraftFile, string> {
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'openwhale-draft', type: 'module', private: true }))

  const filePaths = new Map<DraftFile, string>()
  const deps = new Set<string>()
  for (const file of files) {
    const p = path.join(workDir, `${file.kind}-${file.id}.ts`)
    fs.writeFileSync(p, file.code, 'utf8')
    filePaths.set(file, p)
    for (const dep of bareImports(file.code)) {
      if (!IMPORT_ALLOWLIST.has(dep)) {
        issues.push({ level: 'L1-syntax', file: `${file.kind}/${file.id}`, message: `Import "${dep}" is not allowed — generated code may only import ${[...IMPORT_ALLOWLIST].join(', ')}` })
      } else {
        deps.add(dep)
      }
    }
  }

  const nm = path.join(workDir, 'node_modules')
  for (const dep of deps) {
    const root = resolvePackageRoot(dep)
    if (!root) {
      issues.push({ level: 'L1-syntax', message: `Dependency "${dep}" is not installed in the host process` })
      continue
    }
    const target = path.join(nm, dep)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(root, target, 'junction')
  }
  return filePaths
}

async function runLadder(
  runtime: OpenWhaleRuntime,
  workDir: string,
  files: DraftFile[],
  dryRunTimeoutMs: number,
  credentialStore: unknown,
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = []
  const filePaths = prepareWorkDir(workDir, files, issues)
  if (issues.length > 0) return { passed: false, issues }

  // L1 — syntax
  for (const [file, p] of filePaths) {
    try {
      await esbuild.transform(fs.readFileSync(p, 'utf8'), { loader: 'ts', target: 'es2022' })
    } catch (err) {
      issues.push({ level: 'L1-syntax', file: `${file.kind}/${file.id}`, message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (issues.length > 0) return { passed: false, issues }

  // L2 — types against the real d.ts of core/exchange
  const program = ts.createProgram([...filePaths.values()], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    esModuleInterop: true,
  })
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ')
    const file = d.file ? path.basename(d.file.fileName) : undefined
    issues.push({ level: 'L2-types', ...(file ? { file } : {}), message: `${message}${d.file && d.start !== undefined ? ` (at ${d.file.getLineAndCharacterOfPosition(d.start).line + 1})` : ''}` })
  }
  if (issues.length > 0) return { passed: false, issues }

  // L3 — instantiate and resolve declarations against the live registry
  const probes = new Map<DraftFile, unknown>()
  for (const [file, p] of filePaths) {
    try {
      const { code } = await esbuild.transform(fs.readFileSync(p, 'utf8'), { loader: 'ts', target: 'es2022', format: 'esm' })
      const mjs = p.replace(/\.ts$/, `.${Date.now()}.mjs`)
      fs.writeFileSync(mjs, code, 'utf8')
      // webpackIgnore: runtime-generated file — bundlers must leave this import native
      const mod = await import(/* webpackIgnore: true */ pathToFileURL(mjs).href) as { default?: new () => unknown }
      if (typeof mod.default !== 'function') {
        issues.push({ level: 'L3-registration', file: `${file.kind}/${file.id}`, message: 'Module has no default-exported class' })
        continue
      }
      probes.set(file, new mod.default())
    } catch (err) {
      issues.push({ level: 'L3-registration', file: `${file.kind}/${file.id}`, message: `Failed to instantiate: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  if (issues.length > 0) return { passed: false, issues }

  const monitorIds = new Set(runtime.listMonitors().map(m => m.id))
  const executorIds = new Set(runtime.listExecutors().map(e => e.id))
  const kinds = new Set<string>(runtime.listKinds())
  const declName = (d: unknown) => typeof d === 'string' ? d : (d as { name: string }).name

  for (const [file, probe] of probes) {
    const at = `${file.kind}/${file.id}`
    if (file.kind === 'strategies') {
      const s = probe as IStrategy
      if (!s.strategyId) issues.push({ level: 'L3-registration', file: at, message: 'strategyId is empty' })
      // Generated monitors/executors in the same draft satisfy references too
      const draftMonitors = new Set(files.filter(f => f.kind === 'monitors').map(f => f.id))
      const draftExecutors = new Set(files.filter(f => f.kind === 'executors').map(f => f.id))
      for (const d of s.monitors) {
        const name = declName(d)
        if (!monitorIds.has(name) && !draftMonitors.has(name))
          issues.push({ level: 'L3-registration', file: at, message: `Monitor "${name}" is not registered (use full registry keys)` })
      }
      for (const d of s.executors) {
        const name = declName(d)
        if (!executorIds.has(name) && !draftExecutors.has(name))
          issues.push({ level: 'L3-registration', file: at, message: `Executor "${name}" is not registered (use full registry keys)` })
      }
      for (const slot of s.accounts) {
        if (!slot.account.kind) issues.push({ level: 'L3-registration', file: at, message: `Account slot '${slot.label}': Reader class has no kind` })
        else if (!kinds.has(slot.account.kind)) issues.push({ level: 'L3-registration', file: at, message: `Account slot '${slot.label}': kind "${slot.account.kind}" is not registered` })
      }
      try {
        void (s as unknown as { paramsFields: unknown }).paramsFields
      } catch (err) {
        issues.push({ level: 'L3-registration', file: at, message: `paramsFields derivation failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    } else if (file.kind === 'monitors') {
      const m = probe as { monitorName?: string; emitSchema?: unknown }
      if (!m.monitorName) issues.push({ level: 'L3-registration', file: at, message: 'monitorName is empty' })
      if (!m.emitSchema) issues.push({ level: 'L3-registration', file: at, message: 'Generated monitors must declare emitSchema' })
    } else {
      const e = probe as { executorName?: string; supportedActions?: string[]; actionSchemas?: unknown; credentials?: Array<{ label: string; kind?: string; raw?: boolean }> }
      if (!e.executorName) issues.push({ level: 'L3-registration', file: at, message: 'executorName is empty' })
      if (!e.supportedActions?.length) issues.push({ level: 'L3-registration', file: at, message: 'supportedActions is empty' })
      if (!e.actionSchemas) issues.push({ level: 'L3-registration', file: at, message: 'Generated executors must declare actionSchemas' })
      for (const slot of e.credentials ?? []) {
        if (!slot.raw && slot.kind && !kinds.has(slot.kind))
          issues.push({ level: 'L3-registration', file: at, message: `Credential slot '${slot.label}': kind "${slot.kind}" is not registered` })
      }
    }
  }
  if (issues.length > 0) return { passed: false, issues }

  // L4 — dry-run the strategy over mock readers and synthesized trigger data
  const dryRunInstructions: ValidationReport['dryRunInstructions'] = []
  const strategyEntry = [...probes.entries()].find(([f]) => f.kind === 'strategies')
  if (strategyEntry) {
    const [file, probe] = strategyEntry
    const at = `${file.kind}/${file.id}`
    const s = probe as IStrategy
    try {
      const readers: unknown[] = []
      const names: string[] = []
      for (const slot of s.accounts) {
        // Fresh mock adapter (the kind's 'mock' cell) wrapped in the kind-
        // generic account implementation's read view — the REAL reader over
        // fake data. Kinds without a mock cell degrade to a stub.
        const dryRunReader = runtime.createDryRunReader(slot.account.kind as never)
        readers.push(dryRunReader
          ?? new Proxy({}, { get: (_t, prop) => prop === 'name' ? 'dry-run' : () => Promise.resolve([]) }))
        names.push('dry-run')
      }

      const st = s as unknown as {
        setReaders(r: unknown[], n: string[]): void
        setParams(p: unknown): void
        setInstanceId(id: string): void
        setStore(store: IStrategyStore): void
        setHttpClient(c: HttpClient): void
        setCredentialStore(c: unknown): void
        paramsFields: Array<{ name: string; type: string; group: string; default?: unknown; placeholder?: string }>
        triggers(params: unknown): unknown[]
        run(ctx: StrategyContext): Promise<ExecutionInstruction[]>
        monitors: unknown[]
        executors: unknown[]
      }
      st.setReaders(readers, names)
      st.setInstanceId('dry-run')
      st.setStore(memoryStore())
      st.setHttpClient(new HttpClient('dry-run'))
      if (credentialStore) st.setCredentialStore(credentialStore)

      const base: Record<string, unknown> = {}
      const tunable: Record<string, unknown> = {}
      for (const f of st.paramsFields) {
        const value = f.default ?? sampleFromJsonSchema({ type: f.type === 'options' ? 'string' : f.type })
        if (f.group === 'base') base[f.name] = value
        else tunable[f.name] = value
      }
      st.setParams({ base, tunable })

      const triggers = st.triggers({ base, tunable })
      if (!Array.isArray(triggers) || triggers.length === 0)
        issues.push({ level: 'L4-dryrun', file: at, message: 'triggers() returned no triggers — the strategy would never run' })

      // Synthesize monitor payloads per declared label
      const monitorData: Record<string, Record<string, unknown>> = {}
      const samples = new Map<string, unknown>()
      for (const d of s.monitors) {
        const label = typeof d === 'string' ? d : (d as { label: string }).label
        const name = declName(d)
        const emitSchema = runtime.getMonitorInstance(name)?.emitSchema
        const sample = emitSchema ? sampleFromJsonSchema(z.toJSONSchema(emitSchema)) : {}
        samples.set(label, sample)
        monitorData[`${label}:dry-run`] = sample as Record<string, unknown>
      }
      const context: StrategyContext = {
        instanceId: 'dry-run',
        triggerId: 'dry-run',
        monitorData,
        timestamp: 1,
        getData: (label: string, _key: string) => samples.get(label) as Record<string, unknown> | undefined,
      }

      const instructions = await Promise.race([
        st.run(context),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`dry-run exceeded ${dryRunTimeoutMs}ms`)), dryRunTimeoutMs)),
      ])

      // Validate emitted instructions against the target executors' actionSchemas
      const labelToName = new Map(s.executors.map(d => [typeof d === 'string' ? d : (d as { label: string }).label, declName(d)]))
      for (const ins of instructions) {
        dryRunInstructions.push({ executorLabel: ins.executorId, action: ins.action, params: ins.params })
        const name = labelToName.get(ins.executorId)
        const target = name ? runtime.getExecutorInstance(name) : undefined
        const schema = target?.actionSchemas?.[ins.action]
        if (target && !target.supportedActions.includes(ins.action)) {
          issues.push({ level: 'L4-dryrun', file: at, message: `Instruction action "${ins.action}" is not supported by executor "${name}"` })
        } else if (schema) {
          const parsed = schema.safeParse(ins.params)
          if (!parsed.success)
            issues.push({ level: 'L4-dryrun', file: at, message: `Instruction "${ins.action}" params invalid: ${parsed.error.message}` })
        }
      }
    } catch (err) {
      issues.push({ level: 'L4-dryrun', file: at, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { passed: issues.length === 0, issues, dryRunInstructions }
}

function memoryStore(): IStrategyStore {
  const map = new Map<string, unknown>()
  return {
    async get<T>(key: string) { return map.get(key) as T | undefined },
    async set(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
    async has(key) { return map.has(key) },
    async keys() { return [...map.keys()] },
    async clear() { map.clear() },
  }
}

export async function validateDraft(
  runtime: OpenWhaleRuntime,
  workDir: string,
  files: DraftFile[],
  dryRunTimeoutMs: number,
  credentialStore?: unknown,
): Promise<ValidationReport> {
  try {
    return await runLadder(runtime, workDir, files, dryRunTimeoutMs, credentialStore)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}
