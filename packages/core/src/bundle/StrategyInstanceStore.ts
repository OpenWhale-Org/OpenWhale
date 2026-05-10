import fs from 'fs'
import path from 'path'
import type { StrategyInstance } from '../types/instance.js'
import { getInstancePath, getDataDir } from '../utils/paths.js'

export class StrategyInstanceStore {
  private readonly dataDir: string

  constructor(dataDir?: string) {
    this.dataDir = getDataDir(dataDir)
  }

  async save(instance: StrategyInstance): Promise<void> {
    const filePath = getInstancePath(this.dataDir, instance.id)
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    const tmp = filePath + '.tmp'
    await fs.promises.writeFile(tmp, JSON.stringify(instance, null, 2), 'utf8')
    await fs.promises.rename(tmp, filePath)
  }

  async load(id: string): Promise<StrategyInstance | null> {
    const filePath = getInstancePath(this.dataDir, id)
    try {
      const content = await fs.promises.readFile(filePath, 'utf8')
      return JSON.parse(content) as StrategyInstance
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async loadAll(): Promise<StrategyInstance[]> {
    const dir = path.join(this.dataDir, 'instances')
    try {
      const files = await fs.promises.readdir(dir)
      const instances = await Promise.all(
        files
          .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
          .map(async (f) => {
            const content = await fs.promises.readFile(path.join(dir, f), 'utf8')
            return JSON.parse(content) as StrategyInstance
          })
      )
      return instances
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async delete(id: string): Promise<void> {
    const filePath = getInstancePath(this.dataDir, id)
    try {
      await fs.promises.unlink(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }
}
