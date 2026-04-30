import fs from 'fs'
import readline from 'readline'
import path from 'path'

export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const line = JSON.stringify(record) + '\n'
  await fs.promises.appendFile(filePath, line, 'utf8')
}

export async function readJsonlLines<T = unknown>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8')
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export async function writeJsonlLines(filePath: string, lines: unknown[]): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '')
  const tmp = filePath + '.tmp'
  await fs.promises.writeFile(tmp, content, 'utf8')
  await fs.promises.rename(tmp, filePath)
}

export function streamJsonlLines<T = unknown>(filePath: string): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let rl: readline.Interface | null = null
      let stream: fs.ReadStream | null = null
      const queue: T[] = []
      const waiters: Array<(result: IteratorResult<T>) => void> = []
      let done = false
      let error: unknown = null

      function init() {
        try {
          stream = fs.createReadStream(filePath, { encoding: 'utf8' })
          rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

          rl.on('line', (line) => {
            if (line.trim().length === 0) return
            const parsed = JSON.parse(line) as T
            const waiter = waiters.shift()
            if (waiter) {
              waiter({ value: parsed, done: false })
            } else {
              queue.push(parsed)
            }
          })

          rl.on('close', () => {
            done = true
            for (const waiter of waiters.splice(0)) {
              waiter({ value: undefined as unknown as T, done: true })
            }
          })

          stream.on('error', (err: Error) => {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              done = true
              for (const waiter of waiters.splice(0)) {
                waiter({ value: undefined as unknown as T, done: true })
              }
            } else {
              error = err
              for (const waiter of waiters.splice(0)) {
                waiter({ value: undefined as unknown as T, done: true })
              }
            }
          })
        } catch (err) {
          error = err
          done = true
        }
      }

      init()

      return {
        next(): Promise<IteratorResult<T>> {
          if (error) return Promise.reject(error as Error)
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as T, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as T, done: true })
          }
          return new Promise((resolve) => {
            waiters.push(resolve)
          })
        },
        return(): Promise<IteratorResult<T>> {
          rl?.close()
          stream?.destroy()
          return Promise.resolve({ value: undefined as unknown as T, done: true })
        },
      }
    },
  }
}
