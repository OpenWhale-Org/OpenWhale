import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'

export interface RedisConfig {
  host: string
  port: number
  password?: string
  db?: number
  /** Key prefix for per-executorId streams. Default: 'openwhale:queue' */
  keyPrefix?: string
  /** Consumer group name. All instances of the same executor join this group. Default: 'openwhale' */
  consumerGroup?: string
  /** Unique consumer name within the group (e.g. hostname + pid). Default: auto-generated */
  consumerName?: string
  /** How long (ms) to block on XREADGROUP waiting for new messages. Default: 5000 */
  blockMs?: number
  /** Max number of messages to fetch per XREADGROUP call. Default: 1 */
  batchSize?: number
}

export class RedisExecutionQueue implements ExecutionQueue {
  private readonly keyPrefix: string
  private readonly consumerGroup: string
  private readonly consumerName: string
  private readonly blockMs: number
  private readonly batchSize: number

  constructor(_config: RedisConfig) {
    this.keyPrefix = _config.keyPrefix ?? 'openwhale:queue'
    this.consumerGroup = _config.consumerGroup ?? 'openwhale'
    this.consumerName = _config.consumerName ?? `consumer-${process.pid}`
    this.blockMs = _config.blockMs ?? 5000
    this.batchSize = _config.batchSize ?? 1

    // TODO: initialize ioredis client
    //   this.redis = new Redis({ host, port, password, db })
    //
    // NOTE: Each executorId gets its own Stream key: `${keyPrefix}:${executorId}`
    // Consumer group must be created before consuming:
    //   await this.redis.xgroup('CREATE', streamKey, this.consumerGroup, '$', 'MKSTREAM')
    //   — use '$' to only consume new messages, '0' to replay from beginning
    //   — MKSTREAM creates the stream if it doesn't exist
  }

  /** Returns the Redis Stream key for a given executorId */
  private key(executorId: string): string {
    return `${this.keyPrefix}:${executorId}`
  }

  async push(instruction: ExecutionInstruction): Promise<void> {
    // XADD ${key} * executorId ${executorId} action ${action} params ${JSON.stringify(params)}
    //
    // '*' lets Redis auto-generate the message ID (timestamp-based).
    // Fields are flat key-value pairs; we serialize params as JSON string.
    //
    // Example:
    //   await this.redis.xadd(
    //     this.key(instruction.executorId),
    //     '*',
    //     'executorId', instruction.executorId,
    //     'action',     instruction.action,
    //     'params',     JSON.stringify(instruction.params),
    //   )
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    // Use a pipeline to batch all XADDs in a single round-trip:
    //
    //   const pipeline = this.redis.pipeline()
    //   for (const instruction of instructions) {
    //     pipeline.xadd(
    //       this.key(instruction.executorId), '*',
    //       'executorId', instruction.executorId,
    //       'action',     instruction.action,
    //       'params',     JSON.stringify(instruction.params),
    //     )
    //   }
    //   await pipeline.exec()
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  /**
   * Consume instructions for a specific executorId using Redis Streams consumer groups.
   *
   * Multiple instances with the same executorId join the same consumer group.
   * Redis delivers each message to exactly one consumer in the group (at-most-once per group).
   * After successful processing, the message is ACKed and removed from the PEL
   * (Pending Entries List). If the consumer crashes before ACK, the message stays
   * in the PEL and can be reclaimed via XAUTOCLAIM / XCLAIM.
   *
   * Flow:
   *   1. Ensure consumer group exists (XGROUP CREATE ... MKSTREAM)
   *   2. Loop: XREADGROUP GROUP ${group} ${consumer} COUNT ${batchSize} BLOCK ${blockMs} STREAMS ${key} >
   *      — '>' means "give me only new, undelivered messages"
   *   3. For each message: deserialize → call handler → XACK
   *   4. On stop(): break loop, disconnect
   *
   * Pending message recovery (implement separately):
   *   XAUTOCLAIM ${key} ${group} ${consumer} ${minIdleMs} 0-0 COUNT ${n}
   *   — reclaims messages idle longer than minIdleMs from crashed consumers
   */
  async consume(executorId: string, _handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    // const streamKey = this.key(executorId)
    //
    // // Ensure group exists (idempotent — BUSYGROUP error is ignored)
    // try {
    //   await this.redis.xgroup('CREATE', streamKey, this.consumerGroup, '$', 'MKSTREAM')
    // } catch (err) {
    //   if (!(err as Error).message.includes('BUSYGROUP')) throw err
    // }
    //
    // while (!this.stopped) {
    //   const results = await this.redis.xreadgroup(
    //     'GROUP', this.consumerGroup, this.consumerName,
    //     'COUNT', this.batchSize,
    //     'BLOCK', this.blockMs,
    //     'STREAMS', streamKey, '>'
    //   )
    //   if (!results) continue  // timeout, loop again
    //
    //   for (const [, messages] of results) {
    //     for (const [id, fields] of messages) {
    //       const instruction: ExecutionInstruction = {
    //         executorId: fields[fields.indexOf('executorId') + 1],
    //         action:     fields[fields.indexOf('action') + 1],
    //         params:     JSON.parse(fields[fields.indexOf('params') + 1]),
    //       }
    //       await handler(instruction)
    //       await this.redis.xack(streamKey, this.consumerGroup, id)
    //     }
    //   }
    // }
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async stop(): Promise<void> {
    // this.stopped = true
    // await this.redis.quit()
    throw new Error('RedisExecutionQueue is not yet implemented')
  }
}
