import type { IAssistantRuntime, AssistantOptions, AssistantSession } from './types/index.js'

export class AssistantRuntime implements IAssistantRuntime {
  constructor(_options?: AssistantOptions) {
    // TODO: initialize LLM client (Vercel AI SDK), session store, tool registry
  }

  async chat(_sessionId: string, _message: string): Promise<string> {
    // TODO: load session history, call LLM with tools, persist response
    throw new Error('AssistantRuntime.chat() is not yet implemented')
  }

  async createSession(): Promise<AssistantSession> {
    // TODO: persist new session
    throw new Error('AssistantRuntime.createSession() is not yet implemented')
  }

  async getSession(_sessionId: string): Promise<AssistantSession | null> {
    // TODO: load session from store
    throw new Error('AssistantRuntime.getSession() is not yet implemented')
  }

  async listSessions(): Promise<AssistantSession[]> {
    // TODO: list all sessions from store
    throw new Error('AssistantRuntime.listSessions() is not yet implemented')
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // TODO: remove session from store
    throw new Error('AssistantRuntime.deleteSession() is not yet implemented')
  }
}
