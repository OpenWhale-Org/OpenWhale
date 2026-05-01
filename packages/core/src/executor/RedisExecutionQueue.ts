import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'

export interface RedisConfig {
  host: string
  port: number
  password?: string
  db?: number
  /** Key prefix for per-executorId lists. Default: 'openwhale:queue' */
  keyPrefix?: string
}

export class RedisExecutionQueue implements ExecutionQueue {
  private readonly keyPrefix: string

  constructor(_config: RedisConfig) {
    this.keyPrefix = _config.keyPrefix ?? 'openwhale:queue'
    // TODO: initialize ioredis client
    //   this.redis = new Redis({ host, port, password, db })
    //   this.subscriber = this.redis.duplicate()  // for BLPOP blocking consumer
  }

  /** Returns the Redis list key for a given executorId */
  private key(executorId: string): string {
    return `${this.keyPrefix}:${executorId}`
  }

  async push(instruction: ExecutionInstruction): Promise<void> {
    // TODO: RPUSH this.key(instruction.executorId) JSON.stringify(instruction)
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    // TODO: pipeline RPUSH for each instruction grouped by executorId
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  /**
   * Blocks on BLPOP for the given executorId's list key.
   * Multiple instances consuming the same executorId compete for instructions (at-most-once).
   */
  async consume(executorId: string, _handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    // TODO:
    //   while (!this.stopped) {
    //     const result = await this.redis.blpop(this.key(executorId), 0)
    //     if (!result) continue
    //     const instruction = JSON.parse(result[1]) as ExecutionInstruction
    //     await handler(instruction)
    //   }
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async stop(): Promise<void> {
    // TODO: set stopped flag, disconnect redis client and subscriber
    throw new Error('RedisExecutionQueue is not yet implemented')
  }
}
