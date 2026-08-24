import fs from 'fs'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import path from 'path'
import * as esbuild from 'esbuild'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from '../types/strategy.js'
import { getDataDir, getRegistryPath, getCompiledOutputPath, getCompiledSourcePath } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('CompiledLoader')

const hostRequire = createRequire(path.join(process.cwd(), 'package.json'))
const selfRequire = createRequire(import.meta.url)

/** Package root of a bare specifier, resolved from the host process. */
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

export type CompiledType = 'monitors' | 'executors' | 'strategies'

export interface CompiledLoaderOptions {
  monitorRegistry: MonitorRegistry
  executorRegistry: ExecutorRegistry
  strategyRegistry: StrategyRegistry
  dataDir?: string
  /**
   * Deriving registration path for strategies (the runtime's registerStrategy,
   * which fills monitorIds/executorIds/accountRequirements from the class).
   * Falls back to direct registry.register when absent.
   */
  registerStrategy?: (definition: StrategyDefinition, factory: () => IStrategy) => void
}

export class CompiledLoader {
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly dataDir: string
  private readonly registerStrategy: CompiledLoaderOptions['registerStrategy']

  constructor(options: CompiledLoaderOptions) {
    this.monitorRegistry = options.monitorRegistry
    this.executorRegistry = options.executorRegistry
    this.strategyRegistry = options.strategyRegistry
    this.dataDir = getDataDir(options.dataDir)
    this.registerStrategy = options.registerStrategy
  }

  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadType('monitors'),
      this.loadType('executors'),
      this.loadType('strategies'),
    ])
  }

  /**
   * Unregister a compiled component and delete its files (source, build,
   * legacy registry JSON). Strategies refuse while an ACTIVE instance uses
   * them — the caller passes the live instance list; monitors/executors are
   * unregistered directly (a strategy referencing them fails loudly at its
   * next activation, same as any missing dependency).
   */
  async remove(id: string, type: CompiledType, activeStrategyIds: string[] = []): Promise<void> {
    if (type === 'strategies' && activeStrategyIds.includes(id)) {
      throw new Error(`Compiled strategy "${id}" is used by an active instance — deactivate it first`)
    }
    const registry = type === 'monitors' ? this.monitorRegistry : type === 'executors' ? this.executorRegistry : this.strategyRegistry
    if (registry.get(id)) registry.unregister(id)
    await fs.promises.rm(path.dirname(getCompiledOutputPath(this.dataDir, type, id)), { recursive: true, force: true })
    await fs.promises.rm(getRegistryPath(this.dataDir, type, id), { force: true })
  }

  async recompile(id: string, type: CompiledType): Promise<void> {
    const sourcePath = getCompiledSourcePath(this.dataDir, type, id)
    const outputPath = getCompiledOutputPath(this.dataDir, type, id)

    // Bare imports stay external; {dataDir}/node_modules symlinks let the
    // output resolve them natively at import time (dataDir has no real
    // node_modules of its own).
    await this.linkDependencies(await fs.promises.readFile(sourcePath, 'utf8'))

    await esbuild.build({
      entryPoints: [sourcePath],
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      // Node cannot parse ES decorators (@monitor/@executor/@account) — lower them
      target: 'es2022',
      outfile: outputPath,
    })

    await this.loadEntry(type, id, outputPath)
  }

  /** Symlink each bare-imported package (resolved from the host process) into {dataDir}/node_modules. */
  private async linkDependencies(code: string): Promise<void> {
    const deps = new Set<string>()
    for (const m of code.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) {
      const spec = m[1]!
      if (spec.startsWith('node:')) continue
      deps.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)
    }

    const nm = path.join(this.dataDir, 'node_modules')
    for (const dep of deps) {
      const linkPath = path.join(nm, dep)
      if (fs.existsSync(linkPath)) continue
      const root = resolvePackageRoot(dep)
      if (!root) throw new Error(`Compiled source imports "${dep}", which is not installed in the host process`)
      await fs.promises.mkdir(path.dirname(linkPath), { recursive: true })
      await fs.promises.symlink(root, linkPath, 'junction')
    }
  }

  private async loadType(type: CompiledType): Promise<void> {
    // Discover ids from BOTH sources: registry definition JSONs (legacy /
    // hand-managed) and compiled output directories (AI-compiler approvals
    // write only source + build; their definitions are synthesized).
    const ids = new Set<string>()

    try {
      for (const f of await fs.promises.readdir(path.join(this.dataDir, 'registry', type))) {
        if (f.endsWith('.json')) ids.add(f.slice(0, -5))
      }
    } catch { /* no registry dir */ }

    try {
      const compiledDir = path.dirname(getCompiledOutputPath(this.dataDir, type, 'probe'))
      for (const entry of await fs.promises.readdir(path.dirname(compiledDir), { withFileTypes: true })) {
        if (entry.isDirectory()) ids.add(entry.name)
      }
    } catch { /* no compiled dir */ }

    await Promise.all(
      [...ids].map(async (id) => {
        const outputPath = getCompiledOutputPath(this.dataDir, type, id)
        try {
          await fs.promises.access(outputPath)
        } catch {
          log.warn(`Skipping ${type}/${id}: index.js not found`)
          return
        }
        await this.loadEntry(type, id, outputPath)
      })
    )
  }

  private async loadEntry(type: CompiledType, id: string, outputPath: string): Promise<void> {
    const definitionPath = getRegistryPath(this.dataDir, type, id)
    // A definition file is optional — when absent (e.g. AI-compiler approvals),
    // a minimal one is synthesized from the loaded instance below.
    let definition: MonitorDefinition | ExecutorDefinition | StrategyDefinition | undefined
    try {
      const content = await fs.promises.readFile(definitionPath, 'utf8')
      definition = JSON.parse(content) as MonitorDefinition | ExecutorDefinition | StrategyDefinition
    } catch {
      definition = undefined
    }

    // Use a cache-busting query param to force re-import on recompile
    // webpackIgnore: runtime-generated file — bundlers must leave this import native
    const mod = await import(/* webpackIgnore: true */ `${pathToFileURL(outputPath).href}?t=${Date.now()}`) as { default?: unknown }
    if (typeof mod.default !== 'function') {
      log.warn(`Skipping ${type}/${id}: default export is not a constructor`)
      return
    }

    const Ctor = mod.default as new () => unknown
    const now = new Date().toISOString()

    switch (type) {
      case 'monitors': {
        const instance = new Ctor() as BaseMonitor
        this.monitorRegistry.register(
          (definition as MonitorDefinition | undefined)
            ?? { id, name: instance.monitorName, source: 'compiled', createdAt: now, updatedAt: now },
          instance,
        )
        break
      }
      case 'executors': {
        const instance = new Ctor() as BaseExecutor
        this.executorRegistry.register(
          (definition as ExecutorDefinition | undefined)
            ?? { id, name: instance.executorName, source: 'compiled', supportedActions: instance.supportedActions, createdAt: now, updatedAt: now },
          instance,
        )
        break
      }
      case 'strategies': {
        const def = (definition as StrategyDefinition | undefined)
          ?? { id, name: id, source: 'compiled' as const, createdAt: now, updatedAt: now }
        const factory = () => new Ctor() as IStrategy
        if (this.registerStrategy) this.registerStrategy(def, factory)
        else this.strategyRegistry.register(def, factory)
        break
      }
    }
  }
}
