/**
 * The AuthService singleton, kept separate from auth.ts so routes can reach it
 * without importing the runtime module (and its plugin graph) in a cycle.
 */
import { AuthService } from './auth.js'
import { getDatabase } from './runtime.js'

let authSingleton: AuthService | undefined

export function getAuth(): AuthService {
  if (!authSingleton) authSingleton = new AuthService(getDatabase())
  return authSingleton
}
