import fs from 'fs'
import path from 'path'
import * as esbuild from 'esbuild'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from '../types/strategy.js'
import { getDataDir, getRegistryPath, getCompiledOutputPath, getCompiledSourcePath } from '../utils/paths.js'

export type CompiledType = 'monitors' | 'executors' | 'strategies'

export interface CompiledLoaderOptions {
  monitorRegistry: MonitorRegistry
  executorRegistry: ExecutorRegistry
  strategyRegistry: StrategyRegistry
  dataDir?: string
}

export class CompiledLoader {
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly dataDir: string

  constructor(options: CompiledLoaderOptions) {
    this.monitorRegistry = options.monitorRegistry
    this.executorRegistry = options.executorRegistry
    this.strategyRegistry = options.strategyRegistry
    this.dataDir = getDataDir(options.dataDir)
  }

  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadType('monitors'),
      this.loadType('executors'),
      this.loadType('strategies'),
    ])
  }

  async recompile(id: string, type: CompiledType): Promise<void> {
    const sourcePath = getCompiledSourcePath(this.dataDir, type, id)
    const outputPath = getCompiledOutputPath(this.dataDir, type, id)

    await esbuild.build({
      entryPoints: [sourcePath],
      bundle: true,
      external: ['@openwhale/core'],
      platform: 'node',
      format: 'esm',
      outfile: outputPath,
    })

    await this.loadEntry(type, id, outputPath)
  }

  private async loadType(type: CompiledType): Promise<void> {
    const registryDir = path.join(this.dataDir, 'registry', type)
    let files: string[]
    try {
      files = await fs.promises.readdir(registryDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }

    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const id = f.slice(0, -5)
          const outputPath = getCompiledOutputPath(this.dataDir, type, id)
          try {
            await fs.promises.access(outputPath)
          } catch {
            console.warn(`[CompiledLoader] Skipping ${type}/${id}: index.js not found`)
            return
          }
          await this.loadEntry(type, id, outputPath)
        })
    )
  }

  private async loadEntry(type: CompiledType, id: string, outputPath: string): Promise<void> {
    const definitionPath = getRegistryPath(this.dataDir, type, id)
    let definition: MonitorDefinition | ExecutorDefinition | StrategyDefinition
    try {
      const content = await fs.promises.readFile(definitionPath, 'utf8')
      definition = JSON.parse(content) as MonitorDefinition | ExecutorDefinition | StrategyDefinition
    } catch (err) {
      console.warn(`[CompiledLoader] Skipping ${type}/${id}: definition file not found`)
      return
    }

    // Use a cache-busting query param to force re-import on recompile
    const mod = await import(`${outputPath}?t=${Date.now()}`) as { default?: unknown }
    if (typeof mod.default !== 'function') {
      console.warn(`[CompiledLoader] Skipping ${type}/${id}: default export is not a constructor`)
      return
    }

    const Ctor = mod.default as new () => unknown

    switch (type) {
      case 'monitors':
        this.monitorRegistry.register(
          definition as MonitorDefinition,
          new Ctor() as BaseMonitor
        )
        break
      case 'executors':
        this.executorRegistry.register(
          definition as ExecutorDefinition,
          new Ctor() as BaseExecutor
        )
        break
      case 'strategies':
        this.strategyRegistry.register(
          definition as StrategyDefinition,
          new Ctor() as IStrategy
        )
        break
    }
  }
}
