/**
 * The AuthService singleton, kept separate from auth.ts so routes can reach it
 * without importing the runtime module (and its plugin graph) in a cycle.
 */
import { AuthService } from './auth.js'
import { ScriptShelfService } from './scriptShelf.js'
import { getDatabase } from './runtime.js'

let authSingleton: AuthService | undefined

export function getAuth(): AuthService {
  if (!authSingleton) authSingleton = new AuthService(getDatabase())
  return authSingleton
}

let shelfSingleton: ScriptShelfService | undefined

/** Same reasoning as getAuth: routes reach it without importing the runtime graph. */
export function getScriptShelf(): ScriptShelfService {
  if (!shelfSingleton) shelfSingleton = new ScriptShelfService(getDatabase())
  return shelfSingleton
}
