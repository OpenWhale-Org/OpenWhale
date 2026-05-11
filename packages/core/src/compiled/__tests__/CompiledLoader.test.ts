import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CompiledLoader } from '../CompiledLoader.js'
import { Registry } from '../../registry/Registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../../types/definition.js'
import type { BaseMonitor } from '../../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../../executor/BaseExecutor.js'
import type { IStrategy } from '../../types/strategy.js'

async function writeFixture(
  dataDir: string,
  type: string,
  id: string,
  definition: object,
  jsContent: string
): Promise<void> {
  const registryDir = path.join(dataDir, 'registry', type)
  const compiledDir = path.join(dataDir, 'compiled', type, id)
  await fs.promises.mkdir(registryDir, { recursive: true })
  await fs.promises.mkdir(compiledDir, { recursive: true })
  await fs.promises.writeFile(path.join(registryDir, `${id}.json`), JSON.stringify(definition), 'utf8')
  await fs.promises.writeFile(path.join(compiledDir, 'index.js'), jsContent, 'utf8')
}

const monitorJs = `export default class TestMonitor { get monitorName() { return 'test' } }`
const executorJs = `export default class TestExecutor { get executorName() { return 'test' } get supportedActions() { return [] } }`
const strategyJs = `export default class TestStrategy { get strategyId() { return 'test' } }`

describe('CompiledLoader', () => {
  let tmpDir: string
  let monitorRegistry: Registry<MonitorDefinition, BaseMonitor>
  let executorRegistry: Registry<ExecutorDefinition, BaseExecutor>
  let strategyRegistry: Registry<StrategyDefinition, () => IStrategy>
  let loader: CompiledLoader

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openwhale-compiled-'))
    monitorRegistry = new Registry()
    executorRegistry = new Registry()
    strategyRegistry = new Registry()
    loader = new CompiledLoader({
      monitorRegistry,
      executorRegistry,
      strategyRegistry,
      dataDir: tmpDir,
    })
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('loadAll registers a compiled monitor', async () => {
    const def: MonitorDefinition = {
      id: 'mon-1', name: 'TestMonitor', source: 'compiled',
      compiledPath: path.join(tmpDir, 'compiled', 'monitors', 'mon-1', 'index.js'),
      createdAt: '', updatedAt: '',
    }
    await writeFixture(tmpDir, 'monitors', 'mon-1', def, monitorJs)
    await loader.loadAll()
    expect(monitorRegistry.getDefinition('mon-1')).toBeDefined()
    expect(monitorRegistry.get('mon-1')).toBeDefined()
  })

  it('loadAll registers a compiled executor', async () => {
    const def: ExecutorDefinition = {
      id: 'exec-1', name: 'TestExecutor', source: 'compiled', supportedActions: [],
      compiledPath: path.join(tmpDir, 'compiled', 'executors', 'exec-1', 'index.js'),
      createdAt: '', updatedAt: '',
    }
    await writeFixture(tmpDir, 'executors', 'exec-1', def, executorJs)
    await loader.loadAll()
    expect(executorRegistry.getDefinition('exec-1')).toBeDefined()
  })

  it('loadAll registers a compiled strategy', async () => {
    const def: StrategyDefinition = {
      id: 'strat-1', name: 'TestStrategy', source: 'compiled', monitorIds: [], executorIds: [],
      compiledPath: path.join(tmpDir, 'compiled', 'strategies', 'strat-1', 'index.js'),
      createdAt: '', updatedAt: '',
    }
    await writeFixture(tmpDir, 'strategies', 'strat-1', def, strategyJs)
    await loader.loadAll()
    expect(strategyRegistry.getDefinition('strat-1')).toBeDefined()
  })

  it('loadAll skips entry when index.js is missing', async () => {
    const def: MonitorDefinition = {
      id: 'mon-missing', name: 'Missing', source: 'compiled',
      createdAt: '', updatedAt: '',
    }
    const registryDir = path.join(tmpDir, 'registry', 'monitors')
    await fs.promises.mkdir(registryDir, { recursive: true })
    await fs.promises.writeFile(path.join(registryDir, 'mon-missing.json'), JSON.stringify(def), 'utf8')
    // No index.js written
    await expect(loader.loadAll()).resolves.not.toThrow()
    expect(monitorRegistry.getDefinition('mon-missing')).toBeUndefined()
  })

  it('loadAll returns without error when registry dir does not exist', async () => {
    await expect(loader.loadAll()).resolves.not.toThrow()
  })
})
