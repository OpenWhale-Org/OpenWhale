import type { OpenWhaleRuntime } from '@openwhale/core'

export interface McpServerOptions {
  runtime: OpenWhaleRuntime
  port?: number
}

export class OpenWhaleMcpServer {
  constructor(_options: McpServerOptions) {
    // TODO: initialize MCP server, register tools that expose runtime capabilities
  }

  async start(): Promise<void> {
    // TODO: start MCP server, expose tools:
    //   - activate_bundle(bundle)
    //   - deactivate_bundle(bundleId)
    //   - list_bundles()
    //   - push_instruction(instruction)
    //   - get_monitor_data(monitorName, key, options)
    throw new Error('OpenWhaleMcpServer.start() is not yet implemented')
  }

  async stop(): Promise<void> {
    // TODO: graceful shutdown
    throw new Error('OpenWhaleMcpServer.stop() is not yet implemented')
  }
}
