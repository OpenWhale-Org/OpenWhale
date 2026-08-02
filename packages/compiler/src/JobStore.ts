import fs from 'fs'
import path from 'path'
import type { CompileJob } from './types.js'

/**
 * File-backed job persistence: {dataDir}/compiler/jobs/{jobId}/job.json.
 * Atomic writes (tmp + rename); drafts survive restarts, history stays listable.
 */
export class JobStore {
  constructor(private readonly dataDir: string) {}

  private jobsDir(): string {
    return path.join(this.dataDir, 'compiler', 'jobs')
  }

  jobDir(id: string): string {
    return path.join(this.jobsDir(), id)
  }

  async save(job: CompileJob): Promise<void> {
    const dir = this.jobDir(job.id)
    await fs.promises.mkdir(dir, { recursive: true })
    const target = path.join(dir, 'job.json')
    const tmp = `${target}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(job, null, 1), 'utf8')
    await fs.promises.rename(tmp, target)
  }

  async get(id: string): Promise<CompileJob | undefined> {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(this.jobDir(id), 'job.json'), 'utf8')) as CompileJob
    } catch {
      return undefined
    }
  }

  async list(): Promise<CompileJob[]> {
    let ids: string[]
    try {
      ids = await fs.promises.readdir(this.jobsDir())
    } catch {
      return []
    }
    const jobs = await Promise.all(ids.map(id => this.get(id)))
    return jobs.filter((j): j is CompileJob => j !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async delete(id: string): Promise<void> {
    await fs.promises.rm(this.jobDir(id), { recursive: true, force: true })
  }
}
