/**
 * OpenWhale Gateway — the resident backend process.
 *
 * Owns the ONE OpenWhaleRuntime (monitors, strategies, executors, snapshots)
 * and serves the whole /api/* surface the dashboard consumes (the Next app
 * proxies /api/* here). Runs independently of any frontend: strategies keep
 * trading with the dashboard closed.
 *
 * Env:
 *   OPENWHALE_GATEWAY_PORT   listen port (default 3001)
 *   OPENWHALE_MASTER_KEY     credential encryption key (required)
 *   OPENWHALE_DB_PATH        SQLite path (default ~/.openwhale/openwhale.db)
 *   OPENWHALE_ADMIN_USER     first account, created on an empty user store
 *   OPENWHALE_ADMIN_PASSWORD its password (min 8 chars)
 *   OPENWHALE_ALLOWED_ORIGIN comma-separated browser origins (default
 *                            http://localhost:3000)
 *
 * AUTHENTICATION lives here, not in the dashboard. This process holds the
 * decrypted venue credentials, can place orders, and can install plugins
 * (arbitrary code). A frontend login would be bypassed by anyone who can
 * reach this port, so every /api/* route is gated at the door.
 */
import fs from 'fs'
import path from 'path'
import { parseEnv } from 'util'
import { fileURLToPath } from 'url'
import express from 'express'
import { getLogger } from '@openwhaleorg/core'
import { ensureStarted } from './runtime.js'
import { buildRouter } from './routes.js'
import { getAuth, getScriptShelf } from './authService.js'
import { requireAuth } from './auth.js'

// ── env files ─────────────────────────────────────────────────────────────────
// A plain Node process loads no .env by itself (Next did that for the old
// embedded runtime). Priority: real environment > gateway/.env > repo .env.
// Only MISSING keys are set, so earlier sources always win. Deliberately NO
// dashboard/.env.local fallback: secrets (OPENWHALE_MASTER_KEY encrypts venue
// private keys) belong to the backend — the frontend package must never be a
// place they live.
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')                 // packages/gateway (src/ or dist/)
const repoRoot = path.resolve(pkgRoot, '..', '..')
for (const candidate of [
  path.join(pkgRoot, '.env'),
  path.join(repoRoot, '.env'),
]) {
  if (!fs.existsSync(candidate)) continue
  try {
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(candidate, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch { /* unreadable env file — skip */ }
}

const port = Number(process.env['OPENWHALE_GATEWAY_PORT'] ?? 3001)

const app = express()

// CORS: an allow-list, not a wildcard. Two reasons it had to change —
// `*` is illegal together with credentials (browsers refuse to send the
// session cookie), and once this port is reachable from the internet a
// wildcard invites any page the operator visits to drive their trading API.
// The dashboard normally proxies /api/* same-origin and needs none of this;
// the list exists for direct EventSource/custom frontends.
const allowedOrigins = new Set(
  (process.env['OPENWHALE_ALLOWED_ORIGIN'] ?? 'http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean),
)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
})

// Unauthenticated on purpose: a load balancer must be able to probe liveness.
app.get('/health', (_req, res) => { res.json({ ok: true }) })
app.use(requireAuth(getAuth()))
app.use(buildRouter())

const log = getLogger().child({ module: 'Gateway' })

// Boot the runtime BEFORE listening: a gateway that accepts requests while
// half-started would answer them with empty registries.
ensureStarted()
  .then(async () => {
    const auth = getAuth()
    await auth.initialize()
    await getScriptShelf().initialize()
    if (!await auth.bootstrap()) {
      // Fail closed, exactly as a missing OPENWHALE_MASTER_KEY does. Serving
      // an unauthenticated trading API because configuration was incomplete
      // is the one outcome worth refusing to start over.
      throw new Error(
        'No user account exists and no bootstrap credentials were provided.\n' +
        'Set OPENWHALE_ADMIN_USER and OPENWHALE_ADMIN_PASSWORD (min 8 chars) in the repo-root .env,\n' +
        'start once to create the account, then remove them from the environment.',
      )
    }
  })
  .then(() => {
    app.listen(port, () => {
      log.info({ port }, `OpenWhale Gateway listening on http://localhost:${port}`)
    })
  })
  .catch((err) => {
    log.error({ err }, 'Gateway failed to start')
    process.exit(1)
  })
