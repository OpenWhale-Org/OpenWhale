export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface AssistantSession {
  id: string
  messages: AssistantMessage[]
  createdAt: number
  updatedAt: number
}

export interface AssistantOptions {
  dataDir?: string
  model?: string
}

export interface IAssistantRuntime {
  chat(sessionId: string, message: string): Promise<string>
  createSession(): Promise<AssistantSession>
  getSession(sessionId: string): Promise<AssistantSession | null>
  listSessions(): Promise<AssistantSession[]>
  deleteSession(sessionId: string): Promise<void>
}
