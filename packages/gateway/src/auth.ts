/**
 * Gateway authentication — the system's actual security boundary.
 *
 * The dashboard is only a client. This process holds the decrypted venue
 * credentials, can place orders, and can install plugins (arbitrary code). A
 * login page on the frontend protects nothing: anyone reaching port 3001
 * directly would bypass it. So every /api/* route is gated HERE, and the
 * dashboard simply carries the session cookie.
 *
 * Sessions are opaque tokens in SQLite rather than JWTs — a single-process
 * gateway gains nothing from stateless tokens and loses revocation, which is
 * the one operation that matters when a laptop goes missing.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import type { Request, Response, NextFunction } from 'express'
import type { DatabaseAdapter } from '@openwhaleorg/core'
import { getLogger } from '@openwhaleorg/core'

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>

const log = getLogger().child({ module: 'GatewayAuth' })

export const SESSION_COOKIE = 'ow_session'
/** Sessions outlive a working day but not a holiday. */
const SESSION_TTL_MS = 7 * 24 * 3_600_000
const KEY_LEN = 64

export interface AuthUser {
  id: string
  username: string
  createdAt: string
}

/** Routes reachable without a session — everything else is gated. */
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/status'])

export class AuthService {
  constructor(private readonly db: DatabaseAdapter) {}

  async initialize(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)')
    // Expired rows are dead weight and a liability if the file is ever copied
    await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()])
  }

  async userCount(): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')
    return Number(row?.n ?? 0)
  }

  /**
   * Hash as `scrypt$<salt-hex>$<key-hex>`. Node's own scrypt keeps this
   * dependency-free; the salt is per-user so identical passwords do not
   * produce identical hashes.
   */
  private async hash(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await scrypt(password, salt, KEY_LEN)
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
  }

  private async verifyHash(password: string, stored: string): Promise<boolean> {
    const [scheme, saltHex, keyHex] = stored.split('$')
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false
    const key = await scrypt(password, Buffer.from(saltHex, 'hex'), KEY_LEN)
    const expected = Buffer.from(keyHex, 'hex')
    // Constant-time: a length-sensitive or early-exit compare leaks the hash
    if (key.length !== expected.length) return false
    return timingSafeEqual(key, expected)
  }

  async createUser(username: string, password: string): Promise<AuthUser> {
    const name = username.trim()
    if (!name) throw new Error('username is required')
    if (password.length < 8) throw new Error('password must be at least 8 characters')
    const existing = await this.db.get('SELECT id FROM users WHERE username = ?', [name])
    if (existing) throw new Error(`user "${name}" already exists`)

    const user: AuthUser = { id: randomBytes(8).toString('hex'), username: name, createdAt: new Date().toISOString() }
    await this.db.run(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
      [user.id, user.username, await this.hash(password), user.createdAt],
    )
    return user
  }

  async listUsers(): Promise<AuthUser[]> {
    const rows = await this.db.all<{ id: string; username: string; created_at: string }>(
      'SELECT id, username, created_at FROM users ORDER BY created_at',
    )
    return rows.map(r => ({ id: r.id, username: r.username, createdAt: r.created_at }))
  }

  async deleteUser(id: string): Promise<void> {
    // Never leave the gateway with zero accounts — it would be unreachable
    // until someone edited the database by hand.
    if ((await this.userCount()) <= 1) throw new Error('cannot delete the last user — the gateway would become unreachable')
    await this.db.run('DELETE FROM sessions WHERE user_id = ?', [id])
    await this.db.run('DELETE FROM users WHERE id = ?', [id])
  }

  async changePassword(id: string, password: string): Promise<void> {
    if (password.length < 8) throw new Error('password must be at least 8 characters')
    await this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await this.hash(password), id])
    // Every other session for this user dies with the old password
    await this.db.run('DELETE FROM sessions WHERE user_id = ?', [id])
  }

  /** Verify credentials and open a session. Returns undefined on any failure — never says which half was wrong. */
  async login(username: string, password: string): Promise<{ token: string; user: AuthUser } | undefined> {
    const row = await this.db.get<{ id: string; username: string; password_hash: string; created_at: string }>(
      'SELECT * FROM users WHERE username = ?', [username.trim()],
    )
    if (!row) {
      // Hash anyway: returning early on an unknown username makes account
      // enumeration a timing measurement.
      await this.hash(password)
      return undefined
    }
    if (!await this.verifyHash(password, row.password_hash)) return undefined

    const token = randomBytes(32).toString('hex')
    await this.db.run(
      'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [token, row.id, Date.now() + SESSION_TTL_MS, new Date().toISOString()],
    )
    return { token, user: { id: row.id, username: row.username, createdAt: row.created_at } }
  }

  async logout(token: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE token = ?', [token])
  }

  async userForToken(token: string): Promise<AuthUser | undefined> {
    const row = await this.db.get<{ id: string; username: string; created_at: string; expires_at: number }>(
      `SELECT u.id, u.username, u.created_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`,
      [token],
    )
    if (!row) return undefined
    if (Number(row.expires_at) < Date.now()) {
      await this.db.run('DELETE FROM sessions WHERE token = ?', [token])
      return undefined
    }
    return { id: row.id, username: row.username, createdAt: row.created_at }
  }

  /**
   * Create the first account from env when the store is empty.
   *
   * Returns false when there is no user and no bootstrap configured — the
   * caller refuses to start rather than serve an open trading API.
   */
  async bootstrap(): Promise<boolean> {
    if ((await this.userCount()) > 0) return true
    const username = process.env['OPENWHALE_ADMIN_USER']
    const password = process.env['OPENWHALE_ADMIN_PASSWORD']
    if (!username || !password) return false
    await this.createUser(username, password)
    log.warn({ username }, 'Created the first user from OPENWHALE_ADMIN_USER/PASSWORD — remove them from the environment once you have logged in')
    return true
  }
}

/** Read one cookie without pulling in a parser dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',                       // unreachable from JS, so XSS cannot lift it
    'SameSite=Lax',                   // survives top-level navigation, blocks cross-site POSTs
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),    // omitted on plain http or the browser drops it entirely
  ]
  res.setHeader('Set-Cookie', attrs.join('; '))
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/**
 * The authenticated principal, attached by requireAuth. Express's own Request
 * is not augmented (that needs the express-serve-static-core types, which this
 * package does not depend on directly) — handlers narrow through this instead.
 */
export type AuthedRequest = Request & { user?: AuthUser }

/**
 * Gate every /api/* route except the login handshake.
 *
 * Non-/api paths (/health) pass through: a load balancer must be able to probe
 * the process without credentials.
 */
export function requireAuth(auth: AuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.path.startsWith('/api/') || PUBLIC_PATHS.has(req.path)) { next(); return }

    const token = readCookie(req, SESSION_COOKIE)
      // Bearer for non-browser clients (scripts, curl) that cannot hold cookies
      ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined)
    if (!token) { res.status(401).json({ error: 'authentication required' }); return }

    const user = await auth.userForToken(token)
    if (!user) {
      clearSessionCookie(res)
      res.status(401).json({ error: 'session expired' })
      return
    }
    ;(req as AuthedRequest).user = user
    next()
  }
}
