import { Redis } from 'ioredis'
import type { Redis as RedisClient } from 'ioredis'
import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('RedisExecutionQueue')

export interface RedisConfig {
  host: string
  port: number
  password?: string
  db?: number
  /** Key prefix for per-executorId streams. Default: 'openwhale:queue' */
  keyPrefix?: string
  /** Consumer group name shared by all instances of the same executor. Default: 'openwhale' */
  consumerGroup?: string
  /** Unique consumer name within the group. Default: 'consumer-{pid}' */
  consumerName?: string
  /** How long (ms) to block on XREADGROUP waiting for new messages. Default: 5000 */
  blockMs?: number
  /** Max messages to fetch per XREADGROUP call. Default: 1 */
  batchSize?: number
  /**
   * How often (ms) to run XAUTOCLAIM to reclaim messages from crashed consumers.
   * Default: 30000 (30s)
   */
  reclaimIntervalMs?: number
  /**
   * How long (ms) a message must be idle in the PEL before it can be reclaimed.
   * Should be longer than the expected max execution time. Default: 60000 (60s)
   */
  reclaimMinIdleMs?: number
}

export class RedisExecutionQueue implements ExecutionQueue {
  private readonly redis: RedisClient
  private readonly keyPrefix: string
  private readonly consumerGroup: string
  private readonly consumerName: string
  private readonly blockMs: number
  private readonly batchSize: number
  private readonly reclaimIntervalMs: number
  private readonly reclaimMinIdleMs: number
  private stopped = false
  private reclaimTimers = new Map<string, NodeJS.Timeout>()

  constructor(config: RedisConfig) {
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      lazyConnect: true,
    })
    this.keyPrefix = config.keyPrefix ?? 'openwhale:queue'
    this.consumerGroup = config.consumerGroup ?? 'openwhale'
    this.consumerName = config.consumerName ?? `consumer-${process.pid}`
    this.blockMs = config.blockMs ?? 5000
    this.batchSize = config.batchSize ?? 1
    this.reclaimIntervalMs = config.reclaimIntervalMs ?? 30_000
    this.reclaimMinIdleMs = config.reclaimMinIdleMs ?? 60_000
  }

  private key(executorId: string): string {
    return `${this.keyPrefix}:${executorId}`
  }

  async push(instruction: ExecutionInstruction): Promise<void> {
    await this.redis.xadd(
      this.key(instruction.executorId),
      '*',
      'executorId', instruction.executorId,
      'action',     instruction.action,
      'params',     JSON.stringify(instruction.params),
    )
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    const pipeline = this.redis.pipeline()
    for (const instruction of instructions) {
      pipeline.xadd(
        this.key(instruction.executorId),
        '*',
        'executorId', instruction.executorId,
        'action',     instruction.action,
        'params',     JSON.stringify(instruction.params),
      )
    }
    await pipeline.exec()
  }

  async consume(executorId: string, handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    const streamKey = this.key(executorId)
    await this.ensureGroup(streamKey)
    this.startReclaimLoop(streamKey, handler)

    while (!this.stopped) {
      let results: [string, [string, string[]][]][] | null
      try {
        // '>' = only new messages not yet delivered to any consumer in this group
        results = await (this.redis as RedisClient).xreadgroup(
          'GROUP', this.consumerGroup, this.consumerName,
          'COUNT', String(this.batchSize),
          'BLOCK', String(this.blockMs),
          'STREAMS', streamKey, '>',
        ) as [string, [string, string[]][]][] | null
      } catch (err) {
        if (this.stopped) break
        log.error({ err, executorId }, 'XREADGROUP error')
        continue
      }

      if (!results) continue // BLOCK timeout, loop again

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          const instruction = parseFields(fields)
          try {
            await handler(instruction)
            await this.redis.xack(streamKey, this.consumerGroup, id)
          } catch (err) {
            // Handler failed — do NOT ack. Message stays in PEL and will be
            // reclaimed by XAUTOCLAIM after reclaimMinIdleMs.
            log.error({ err, executorId, messageId: id }, 'Handler failed, message left in PEL for reclaim')
          }
        }
      }
    }

    this.stopReclaimLoop(executorId)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const executorId of this.reclaimTimers.keys()) {
      this.stopReclaimLoop(executorId)
    }
    await this.redis.quit()
  }

  // ---------------------------------------------------------------------------
  // Consumer group setup
  // ---------------------------------------------------------------------------

  private async ensureGroup(streamKey: string): Promise<void> {
    try {
      // '$' = only consume messages added after group creation
      // MKSTREAM = create the stream if it doesn't exist yet
      await this.redis.xgroup('CREATE', streamKey, this.consumerGroup, '$', 'MKSTREAM')
    } catch (err) {
      // BUSYGROUP = group already exists, safe to ignore
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err
    }
  }

  // ---------------------------------------------------------------------------
  // XAUTOCLAIM — periodic reclaim of messages from crashed consumers
  // ---------------------------------------------------------------------------

  /**
   * Starts a periodic loop that uses XAUTOCLAIM to reclaim messages that have
   * been idle in the PEL longer than reclaimMinIdleMs (i.e. delivered to a
   * consumer that crashed before ACKing).
   *
   * Reclaimed messages are re-delivered to this consumer and processed normally.
   * This provides at-least-once semantics for crash recovery — handlers should
   * be idempotent where possible.
   */
  private startReclaimLoop(
    streamKey: string,
    handler: (instruction: ExecutionInstruction) => Promise<void>,
  ): void {
    const executorId = streamKey.slice(this.keyPrefix.length + 1)
    const timer = setInterval(async () => {
      if (this.stopped) return
      try {
        await this.reclaimPending(streamKey, executorId, handler)
      } catch (err) {
        log.error({ err, executorId }, 'XAUTOCLAIM error')
      }
    }, this.reclaimIntervalMs)
    this.reclaimTimers.set(executorId, timer)
  }

  private stopReclaimLoop(executorId: string): void {
    const timer = this.reclaimTimers.get(executorId)
    if (timer) {
      clearInterval(timer)
      this.reclaimTimers.delete(executorId)
    }
  }

  private async reclaimPending(
    streamKey: string,
    executorId: string,
    handler: (instruction: ExecutionInstruction) => Promise<void>,
  ): Promise<void> {
    // XAUTOCLAIM key group consumer min-idle-time start [COUNT count]
    // Returns: [nextCursor, [[id, fields], ...], [deletedIds]]
    // Cursor '0-0' = scan from the beginning of the PEL
    let cursor = '0-0'

    while (true) {
      const result = await (this.redis as RedisClient).xautoclaim(
        streamKey,
        this.consumerGroup,
        this.consumerName,
        String(this.reclaimMinIdleMs),
        cursor,
        'COUNT', '10',
      ) as [string, [string, string[]][], string[]]

      const [nextCursor, messages] = result

      for (const [id, fields] of messages) {
        if (!fields || fields.length === 0) continue // deleted message
        const instruction = parseFields(fields)
        log.warn({ executorId, messageId: id }, 'Reclaiming pending message from crashed consumer')
        try {
          await handler(instruction)
          await this.redis.xack(streamKey, this.consumerGroup, id)
        } catch (err) {
          log.error({ err, executorId, messageId: id }, 'Reclaimed message handler failed, will retry next cycle')
        }
      }

      // '0-0' cursor means we've scanned the entire PEL
      if (nextCursor === '0-0') break
      cursor = nextCursor
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFields(fields: string[]): ExecutionInstruction {
  const map: Record<string, string> = {}
  for (let i = 0; i < fields.length - 1; i += 2) {
    map[fields[i]!] = fields[i + 1]!
  }
  return {
    executorId: map['executorId'] ?? '',
    action:     map['action'] ?? '',
    params:     map['params'] ? JSON.parse(map['params']) as Record<string, unknown> : {},
  }
}
