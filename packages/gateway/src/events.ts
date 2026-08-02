import type { Request, Response } from 'express'
import { subscribeLogs } from '@openwhaleorg/core'
import type { StrategyRunEvent, LogRecord, OpenWhaleRuntime } from '@openwhaleorg/core'
import type { CompilerEvent, CompilerService } from '@openwhaleorg/compiler'

/**
 * SSE endpoint — streams monitor emits, strategy runs, compiler progress and
 * component logs to the browser. Connect with new EventSource('/api/events')
 * (the dashboard proxies /api/* here).
 */
export function sseHandler(runtime: OpenWhaleRuntime, compiler: CompilerService) {
  return (req: Request, res: Response): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000)

    // Monitor emit events
    const monitorHandlers: Array<{ monitor: NonNullable<ReturnType<OpenWhaleRuntime['getMonitor']>>; handler: (key: string, data: unknown) => void }> = []
    for (const def of runtime.listMonitors()) {
      const monitor = runtime.getMonitor(def.id)
      if (!monitor) continue
      const handler = (key: string, data: unknown) => {
        send({ type: 'monitor_emit', monitor: def.id, key, data, ts: Date.now() })
      }
      monitor.addEmitHandler(handler)
      monitorHandlers.push({ monitor, handler })
    }

    // Strategy run events
    const strategyRunHandler = (event: StrategyRunEvent) => send({ type: 'strategy_run', ...event })
    runtime.addStrategyRunHandler(strategyRunHandler)

    // AI compiler job progress
    const compilerHandler = (event: CompilerEvent) => send({ type: 'compiler', event })
    compiler.on('event', compilerHandler)

    // Component logs, attributed via module bindings (monitors AND executors)
    const moduleToComponent = new Map<string, { type: 'monitor_log' | 'executor_log'; id: string }>()
    for (const def of runtime.listMonitors()) {
      const moduleName = runtime.getMonitorInstance(def.id)?.monitorName
      if (moduleName) moduleToComponent.set(moduleName, { type: 'monitor_log', id: def.id })
    }
    for (const def of runtime.listExecutors()) {
      const moduleName = runtime.getExecutorInstance(def.id)?.executorName
      if (moduleName) moduleToComponent.set(moduleName, { type: 'executor_log', id: def.id })
    }
    const unsubscribeLogs = subscribeLogs((record: LogRecord) => {
      const component = record.module ? moduleToComponent.get(record.module) : undefined
      if (!component) return
      send({ type: component.type, monitor: component.id, level: record.level, msg: record.msg, extra: record.extra, ts: record.ts })
    })

    req.on('close', () => {
      clearInterval(heartbeat)
      for (const { monitor, handler } of monitorHandlers) monitor.removeEmitHandler(handler)
      runtime.removeStrategyRunHandler(strategyRunHandler)
      compiler.off('event', compilerHandler)
      unsubscribeLogs()
      res.end()
    })
  }
}
