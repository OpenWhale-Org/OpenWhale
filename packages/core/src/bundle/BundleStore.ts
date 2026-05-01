import fs from 'fs'
import path from 'path'
import type { StrategyBundle } from '../types/bundle.js'
import { getBundlePath, getDataDir } from '../utils/paths.js'

export class BundleStore {
  private readonly dataDir: string

  constructor(dataDir?: string) {
    this.dataDir = getDataDir(dataDir)
  }

  async save(bundle: StrategyBundle): Promise<void> {
    const filePath = getBundlePath(this.dataDir, bundle.id)
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    const tmp = filePath + '.tmp'
    await fs.promises.writeFile(tmp, JSON.stringify(bundle, null, 2), 'utf8')
    await fs.promises.rename(tmp, filePath)
  }

  async load(id: string): Promise<StrategyBundle | null> {
    const filePath = getBundlePath(this.dataDir, id)
    try {
      const content = await fs.promises.readFile(filePath, 'utf8')
      return JSON.parse(content) as StrategyBundle
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async loadAll(): Promise<StrategyBundle[]> {
    const dir = path.join(this.dataDir, 'bundles')
    try {
      const files = await fs.promises.readdir(dir)
      const bundles = await Promise.all(
        files
          .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
          .map(async (f) => {
            const content = await fs.promises.readFile(path.join(dir, f), 'utf8')
            return JSON.parse(content) as StrategyBundle
          })
      )
      return bundles
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async delete(id: string): Promise<void> {
    const filePath = getBundlePath(this.dataDir, id)
    try {
      await fs.promises.unlink(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }
}
