import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'

export interface RedisConfig {
  host: string
  port: number
  password?: string
  db?: number
  queueKey?: string
}

export class RedisExecutionQueue implements ExecutionQueue {
  constructor(_config: RedisConfig) {
    // TODO: initialize ioredis client
  }

  async push(_instruction: ExecutionInstruction): Promise<void> {
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async pushBatch(_instructions: ExecutionInstruction[]): Promise<void> {
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async consume(_handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    throw new Error('RedisExecutionQueue is not yet implemented')
  }

  async stop(): Promise<void> {
    throw new Error('RedisExecutionQueue is not yet implemented')
  }
}
