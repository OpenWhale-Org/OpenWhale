/**
 * The gateway's HTTP surface — a 1:1 port of the dashboard's former Next API
 * routes, SAME PATHS, so the frontend needed zero client changes (Next now
 * proxies /api/* here). Handlers stay thin: parse → runtime call → JSON.
 */
import { Router, json } from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { z } from 'zod'
import { getAlertService, type AlertSettings } from './notify/alerts.js'
import { aggregateAccountEquity, BaseStrategy, decodeMonitorKey, getDataDir, recentLogs } from '@openwhaleorg/core'
import type { CompiledLoader, CompiledType, DBCredentialStore, StrategyInstance } from '@openwhaleorg/core'
import type { CompilerSettings } from '@openwhaleorg/compiler'
import { ensureStarted, getRuntime } from './runtime.js'
import { getRetentionService } from './maintenance/retention.js'
import { ensureCompiler, getCompilerService } from './compiler.js'
import { installFromNpm, installFromGithub, installFromFile, uninstallPlugin, listInstalledPlugins, PluginConflictError, describeSource, checkPluginUpdates, updatePlugin, reloadUnloaded } from './plugins.js'
import { watchKey, unwatchKey, listManualWatches } from './monitorWatch.js'
import { sseHandler } from './events.js'
import { activityMeter } from './activity.js'
import { getAuth, getScriptShelf } from './authService.js'
import { SESSION_COOKIE, readCookie, setSessionCookie, clearSessionCookie } from './auth.js'
import type { AuthedRequest } from './auth.js'
import { readExecutions } from './executions.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

/**
 * Market catalogues are thousands of rows and change on the order of days,
 * while a picker asks for them every time a form opens — cache per
 * (kind, venue) rather than hitting the venue each time.
 */
const MARKET_TTL_MS = 10 * 60_000
const marketCache = new Map<string, { at: number; markets: unknown[] }>()
/** Leverage brackets change rarely; a venue-wide read is expensive and weighted. */
const LEVERAGE_TTL_MS = 30 * 60_000
const leverageCache = new Map<string, { at: number; tiers: unknown[] }>()

function getCredentialStore(): DBCredentialStore {
  // credentialStore is private on OpenWhaleRuntime; cast until core exposes a facade
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getRuntime() as any).credentialStore as DBCredentialStore
}

/** True when the request reached us over TLS, directly or through a proxy. */
function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https'
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Wrap an async handler; unexpected throws become 500s instead of hung sockets. */
function h(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (!res.headersSent) res.status(500).json({ error: errText(err) })
    })
  }
}

export function buildRouter(): Router {
  const router = Router()
  router.use(json({ limit: '10mb' }))

  // ── auth ────────────────────────────────────────────────────────────────────
  //
  // The only routes reachable without a session. Everything below is gated by
  // the requireAuth middleware mounted ahead of this router.

  router.get('/api/auth/status', h(async (_req, res) => {
    // Lets the login page tell "no account configured" apart from "wrong
    // password" without exposing anything a stranger could use.
    res.json({ configured: (await getAuth().userCount()) > 0 })
  }))

  router.post('/api/auth/login', h(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) { res.status(400).json({ error: 'username and password are required' }); return }
    const result = await getAuth().login(username, password)
    if (!result) {
      // One message for both failure modes — anything finer is an account oracle
      res.status(401).json({ error: 'invalid username or password' })
      return
    }
    // Secure only over TLS: the browser silently drops a Secure cookie on
    // plain http, which would look like "login does nothing".
    setSessionCookie(res, result.token, isSecureRequest(req))
    res.json({ user: result.user })
  }))

  router.post('/api/auth/logout', h(async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE)
    if (token) await getAuth().logout(token)
    clearSessionCookie(res)
    res.json({ ok: true })
  }))

  router.get('/api/auth/me', h(async (req, res) => {
    res.json({ user: (req as AuthedRequest).user })
  }))

  // ── users ───────────────────────────────────────────────────────────────────

  router.get('/api/users', h(async (_req, res) => {
    res.json(await getAuth().listUsers())
  }))

  router.post('/api/users', h(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) { res.status(400).json({ error: 'username and password are required' }); return }
    try {
      res.status(201).json(await getAuth().createUser(username, password))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.post('/api/users/:id/password', h(async (req, res) => {
    const { password } = (req.body ?? {}) as { password?: string }
    if (!password) { res.status(400).json({ error: 'password is required' }); return }
    try {
      await getAuth().changePassword(req.params['id']!, password)
      // Changing your own password ends this session too — log in again
      if ((req as AuthedRequest).user?.id === req.params['id']) clearSessionCookie(res)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.delete('/api/users/:id', h(async (req, res) => {
    try {
      await getAuth().deleteUser(req.params['id']!)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  // ── accounts ────────────────────────────────────────────────────────────────

  router.get('/api/accounts', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json({
      accounts: await runtime.listAccounts(),
      implementations: runtime.listAccountImplementations(),
      snapshots: await runtime.latestAccountSnapshots(),
    })
  }))

  router.post('/api/accounts', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      res.status(201).json(await runtime.saveAccount(req.body as { name: string; implementation: string; credential?: string; params?: Record<string, unknown> }))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.post('/api/accounts/snapshot', h(async (_req, res) => {
    const runtime = await ensureStarted()
    await runtime.snapshotAccounts()
    res.json({ accounts: await runtime.listAccounts(), snapshots: await runtime.latestAccountSnapshots() })
  }))

  router.delete('/api/accounts/:name', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      await runtime.deleteAccount(req.params['name']!)
      res.json({ ok: true })
    } catch (err) {
      res.status(409).json({ error: errText(err) })
    }
  }))

  router.get('/api/accounts/:name/detail', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      res.json(await runtime.accountDetail(req.params['name']!))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.get('/api/accounts/:name/snapshots', h(async (req, res) => {
    const runtime = await ensureStarted()
    const hours = Math.min(Math.max(Number(req.query['hours'] ?? 24) || 24, 1), 24 * 30)
    res.json(await runtime.accountEquitySeries(req.params['name']!, Date.now() - hours * 3_600_000))
  }))

  router.get('/api/portfolio/equity-series', h(async (req, res) => {
    const runtime = await ensureStarted()
    const ranges = {
      '24h': { hours: 24, bucketMs: 5 * 60_000 },
      '7d': { hours: 24 * 7, bucketMs: 30 * 60_000 },
      '30d': { hours: 24 * 30, bucketMs: 2 * 3_600_000 },
    } as const
    const range = String(req.query['range'] ?? '7d').toLowerCase()
    const selected = ranges[range as keyof typeof ranges]
    if (!selected) {
      res.status(400).json({ error: 'range must be one of 24h, 7d, or 30d' })
      return
    }

    const to = Date.now()
    const from = to - selected.hours * 3_600_000
    const accounts = (await runtime.listAccounts())
      .filter(account => account.status === 'ready')
      .map(account => account.name)
    const recordsByAccount = Object.fromEntries(await Promise.all(accounts.map(async account => [
      account,
      await runtime.accountEquitySeries(account, from),
    ])))

    res.json({
      range,
      sampledAt: to,
      ...aggregateAccountEquity({
        recordsByAccount,
        expectedAccounts: accounts,
        from,
        to,
        bucketMs: selected.bucketMs,
      }),
    })
  }))

  router.delete('/api/accounts/:name/snapshots', h(async (req, res) => {
    const runtime = await ensureStarted()
    await runtime.clearAccountSnapshots(req.params['name']!)
    res.json({ ok: true })
  }))

  // ── credentials ─────────────────────────────────────────────────────────────

  router.get('/api/credential-types', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json(runtime.describeCredentialTypes())
  }))

  router.post('/api/credential-types/:type/test', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      await runtime.testCredential(req.params['type']!, (req.body as { data?: Record<string, unknown> }).data ?? {})
      res.json({ ok: true })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.get('/api/credentials', h(async (_req, res) => {
    const runtime = await ensureStarted()
    const list = await getCredentialStore().list()
    const enriched = await Promise.all(list.map(async (info) => {
      try {
        return { ...info, publicData: await runtime.getCredentialPublicData(info.name) }
      } catch {
        return { ...info, publicData: {} }
      }
    }))
    res.json(enriched)
  }))

  router.post('/api/credentials', h(async (req, res) => {
    await ensureStarted()
    const body = req.body as { name: string; type: string; data: Record<string, unknown> }
    res.status(201).json(await getCredentialStore().set(body.name, body.type, body.data))
  }))

  router.put('/api/credentials/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    const store = getCredentialStore()
    const info = (await store.list()).find(c => c.id === req.params['id'])
    if (!info) { res.status(404).send('credential not found'); return }
    const body = req.body as { data?: Record<string, unknown> }
    if (!body.data) { res.status(400).send('data is required'); return }
    const schema = runtime.listCredentialTypes().find(t => t.type === info.type)?.schema
    try {
      const data = schema ? (schema.parse(body.data) as Record<string, unknown>) : body.data
      res.json(await store.set(info.name, info.type, data))
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.delete('/api/credentials/:id', h(async (req, res) => {
    await ensureStarted()
    await getCredentialStore().delete(req.params['id']!)
    res.json({ ok: true })
  }))

  // ── Scripts — on-demand plugin utilities ─────────────────────────────────────

  router.get('/api/scripts', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json(await runtime.listScripts())
  }))

  /* Shelf = how the page is arranged (folders + what is taken off it).
     Declared BEFORE the /:owner/:sid routes so 'shelf' is never read as a
     plugin name. Purely presentational: an unmounted script still runs. */
  router.get('/api/scripts/shelf', h(async (_req, res) => {
    res.json(await getScriptShelf().get())
  }))

  router.put('/api/scripts/shelf', h(async (req, res) => {
    res.json(await getScriptShelf().put(req.body))
  }))

  router.post('/api/scripts/:owner/:sid/run', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      const params = ((req.body ?? {}) as { params?: Record<string, unknown> }).params ?? {}
      res.json(await runtime.runScript(`${req.params['owner']}/${req.params['sid']}`, params))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  /**
   * Streaming run — NDJSON, one JSON object per line.
   *
   * The unary route above is capped by whatever sits in front of it: the
   * dashboard proxies /api through Next, which severs the connection at 30s,
   * so a script that worked for longer returned nothing at all and the browser
   * saw a bare "Internal Server Error". Streaming keeps bytes moving, so the
   * proxy's idle timer never fires, and the operator sees the run progress
   * instead of a blank wait.
   *
   * Frames: {type:'line',text} while running, then exactly one terminal frame,
   * either {type:'result',text,json} or {type:'error',error}.
   */
  router.post('/api/scripts/:owner/:sid/stream', h(async (req, res) => {
    const runtime = await ensureStarted()
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    // Without this nginx buffers the whole response and streaming silently
    // degrades back into one late blob — the exact failure being fixed.
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const write = (frame: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(frame) + '\n') }
    // A script can be busy for a long stretch without a word (one slow venue
    // round trip). The heartbeat is what actually holds the proxy open then.
    const beat = setInterval(() => write({ type: 'ping' }), 10_000)
    // Stop = the client closes the stream. The script sees it as an abort
    // signal and returns early with what it has.
    const abort = new AbortController()
    req.on('close', () => abort.abort())
    try {
      const params = ((req.body ?? {}) as { params?: Record<string, unknown> }).params ?? {}
      const result = await runtime.runScript(
        `${req.params['owner']}/${req.params['sid']}`, params,
        (line) => write({ type: 'line', text: line }),
        abort.signal,
      )
      write({ type: 'result', ...result })
    } catch (err) {
      write({ type: 'error', error: errText(err) })
    } finally {
      clearInterval(beat)
      if (!res.writableEnded) res.end()
    }
  }))

  // ── instances ───────────────────────────────────────────────────────────────

  router.get('/api/instances', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json(await runtime.listInstanceViews())
  }))

  /**
   * Headline numbers for the instances page. One request instead of the
   * N+1 the dashboard would otherwise make (every instance's runs, then its
   * PnL) — and the only place that knows how long the event meter has
   * actually been watching.
   */
  router.get('/api/stats', h(async (_req, res) => {
    const runtime = await ensureStarted()
    activityMeter.sync(runtime)
    const since = Date.now() - 24 * 3_600_000

    const [views, runs, pnl] = await Promise.all([
      runtime.listInstanceViews(),
      runtime.countRuns(since),
      runtime.allInstancePnl().catch(() => ({} as Record<string, { net: number; realized: number; fees: number; funding: number; unrealized: number | null }>)),
    ])

    const totals = Object.values(pnl).reduce(
      (acc, p) => ({
        net: acc.net + p.net,
        realized: acc.realized + p.realized,
        fees: acc.fees + p.fees,
        funding: acc.funding + p.funding,
        // null anywhere means "the venue could not be reached" — do not add it
        // to a number the user would read as complete
        unrealized: p.unrealized === null || acc.unrealized === null ? null : acc.unrealized + p.unrealized,
      }),
      { net: 0, realized: 0, fees: 0, funding: 0, unrealized: 0 as number | null },
    )

    res.json({
      instances: { total: views.length, running: views.filter(v => v.active).length },
      runs: { ...runs, windowHours: 24 },
      events: activityMeter.read(24),
      pnl: totals,
    })
  }))

  router.get('/api/instances/:id/runs', h(async (req, res) => {
    const runtime = await ensureStarted()
    const id = req.params['id']!
    const strategy = runtime.getStrategy?.(id) as { getRecentRuns?: () => Array<{ startedAt: number; triggerId: string }> } | undefined
    // Live ring first (it has EVERY recent run; disk samples the no-ops),
    // then persisted history so stopped instances and restarts still show why.
    const live = strategy?.getRecentRuns?.() ?? []
    const seen = new Set(live.map(r => `${r.startedAt}:${r.triggerId}`))
    const persisted = (await runtime.readInstanceRuns(id, 100)).filter(r => !seen.has(`${r.startedAt}:${r.triggerId}`))
    res.json([...live, ...persisted].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100))
  }))

  router.get('/api/instances/:id/runs/:runId', h(async (req, res) => {
    const runtime = await ensureStarted()
    const id = req.params['id']!
    const runId = req.params['runId']!
    const strategy = runtime.getStrategy?.(id) as { getRecentRuns?: () => Array<{ runId?: string }> } | undefined
    // The live ring holds runs the sampler never wrote (a no-op run that still
    // explains why nothing was emitted), so it is asked first.
    const live = strategy?.getRecentRuns?.()?.find(r => r.runId === runId)
    const run = live ?? await runtime.readInstanceRun(id, runId)
    if (!run) { res.status(404).json({ error: `no run "${runId}" for instance ${id}` }); return }
    res.json(run)
  }))

  // ── PnL attribution (order-claim ledger) ─────────────────────────────────

  router.get('/api/pnl/summary', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json(await runtime.allInstancePnl())
  }))

  router.get('/api/instances/:id/pnl', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      res.json(await runtime.instancePnl(req.params['id']!))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.get('/api/instances/:id/pnl/series', h(async (req, res) => {
    const runtime = await ensureStarted()
    const n = Math.min(600, Math.max(8, Number(req.query['n']) || 120))
    try {
      res.json(await runtime.instancePnlSeries(req.params['id']!, n))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.get('/api/instances/:id/fills', h(async (req, res) => {
    const runtime = await ensureStarted()
    const limit = Math.min(1000, Math.max(1, Number(req.query['n']) || 200))
    try {
      res.json(await runtime.instanceFills(req.params['id']!, limit))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.get('/api/instances/:id/positions', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      res.json(await runtime.instancePositions(req.params['id']!))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.post('/api/pnl/collect', h(async (_req, res) => {
    const runtime = await ensureStarted()
    await runtime.collectPnlNow()
    res.json({ ok: true })
  }))

  router.get('/api/instances/:id/scope', h(async (req, res) => {
    const runtime = await ensureStarted()
    res.json(runtime.instanceScope(req.params['id']!))
  }))

  /** BaseStrategy's per-run heartbeat lines — pure volume, zero information in a log view. */
  const FRAMEWORK_LOG_NOISE = new Set(['Strategy run started', 'Strategy run completed'])

  /**
   * The log lines this instance's strategy and executors produced.
   *
   * Log records carry a free-form module name ('FundingArbStrategy',
   * 'timed-arb'), not an instance id, so the match is by normalized substring
   * against the instance's strategy id and executor keys — loose on purpose:
   * an over-inclusive log view beats a silently empty one.
   */
  router.get('/api/instances/:id/logs', h(async (req, res) => {
    const runtime = await ensureStarted()
    const scope = runtime.instanceScope(req.params['id']!)
    const inst = (await runtime.listInstanceViews()).find(i => i.id === req.params['id'])
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const tokens = [
      ...(inst ? String(inst.strategyId ?? '').split('/') : []),
      ...scope.executors.flatMap(e => e.split('/')),
    ].map(norm).filter(tok => tok.length >= 4)
    const n = Math.min(1000, Math.max(1, Number(req.query['n']) || 200))
    const all = recentLogs(undefined, 1000)
    const mine = all.filter((r) => {
      // Framework heartbeat chatter — the Runs tab already shows every run.
      if (FRAMEWORK_LOG_NOISE.has(r.msg)) return false
      // Lines that carry an instanceId match exactly — two instances of the
      // same strategy must not read each other's logs.
      const rid = (r.extra as Record<string, unknown> | undefined)?.['instanceId']
      if (rid !== undefined) return rid === req.params['id']
      if (tokens.length === 0) return true
      const m = norm(r.module ?? '')
      return m !== '' && tokens.some(tok => m.includes(tok) || tok.includes(m))
    })
    if (mine.length > 0) { res.json(mine.slice(-n)); return }
    // Live ring is empty (stopped instance, or the gateway restarted) — replay
    // the log lines captured inside persisted run traces instead.
    const replayed = (await runtime.readInstanceRuns(req.params['id']!, 50))
      .flatMap(r => r.steps.filter(s => s.step.startsWith('log:') && !FRAMEWORK_LOG_NOISE.has(String((s.data as { msg?: string } | undefined)?.msg))).map(s => {
        const { module, msg, ...extra } = (s.data ?? {}) as { module?: string; msg?: string } & Record<string, unknown>
        return {
          ts: s.ts, level: s.step.slice(4),
          ...(module !== undefined ? { module } : {}),
          msg: String(msg ?? ''),
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        }
      }))
      .sort((a, b) => a.ts - b.ts)
    res.json(replayed.slice(-n))
  }))

  router.post('/api/instances', h(async (req, res) => {
    const runtime = await ensureStarted()
    const instance = req.body as StrategyInstance
    try {
      /* `enabled: false` used to be accepted and ignored — every create
         started trading, whatever the form said. Saving stopped is the whole
         point of the option, so it is honoured here. */
      if (instance.enabled === false) await runtime.saveInstance(instance)
      else await runtime.activate(instance)
      res.status(201).json({ ok: true })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  // Stop but keep the persisted row (edit/resume later)
  router.post('/api/instances/:id/deactivate', h(async (req, res) => {
    const runtime = await ensureStarted()
    await runtime.deactivate(req.params['id']!)
    res.json({ ok: true })
  }))

  // Resume a stopped instance
  router.post('/api/instances/:id/activate', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      await runtime.activateById(req.params['id']!)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  // Edit an instance (any field) — 409 while active unless ?restart=1, which
  // rebuilds it from the new settings instead of refusing. A restart that the
  // new settings fail rolls back to the old ones and still reports 400, so a
  // rejected edit never leaves a running strategy stopped.
  router.patch('/api/instances/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    const restart = req.query['restart'] === '1' || req.query['restart'] === 'true'
    try {
      res.json(await runtime.updateInstance(
        req.params['id']!, req.body as Parameters<typeof runtime.updateInstance>[1], { restart },
      ))
    } catch (err) {
      const message = errText(err)
      res.status(message.includes('is active') ? 409 : 400).send(message)
    }
  }))

  // Cosmetic metadata (icon/folder/order/name/description) — allowed while active
  router.patch('/api/instances/:id/meta', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      res.json(await runtime.updateInstanceMeta(req.params['id']!, req.body as Parameters<typeof runtime.updateInstanceMeta>[1]))
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  // Copy an instance's configuration into a new stopped instance
  router.post('/api/instances/:id/duplicate', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      const { name } = (req.body ?? {}) as { name?: string }
      res.status(201).json(await runtime.duplicateInstance(req.params['id']!, name))
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  // Remove entirely (stops first if active)
  router.delete('/api/instances/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    await runtime.deleteInstance(req.params['id']!)
    res.json({ ok: true })
  }))

  /* The strategy's own KV state: what it has written, and a way to wipe it.
     Clearing is refused while the instance runs — see clearInstanceStore. */
  router.get('/api/instances/:id/store', h(async (req, res) => {
    const runtime = await ensureStarted()
    res.json({ keys: await runtime.instanceStoreKeys(req.params['id']!) })
  }))

  router.delete('/api/instances/:id/store', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      res.json({ cleared: await runtime.clearInstanceStore(req.params['id']!) })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.get('/api/instances/:id/executions', h(async (req, res) => {
    res.json(await readExecutions(dataDirFromEnv(), { instanceId: req.params['id']!, limit: 200 }))
  }))

  /**
   * Every instance's executions, newest first — the Executions page.
   *
   * The same log the per-instance route reads; only the filter differs. What
   * makes it usable across instances is `instruction.runId`, which points at
   * the run that decided each one (see /api/instances/:id/runs/:runId).
   */
  router.get('/api/executions', h(async (req, res) => {
    const q = req.query
    res.json(await readExecutions(dataDirFromEnv(), {
      limit: Number(q['limit']) || 100,
      ...(typeof q['instanceId'] === 'string' ? { instanceId: q['instanceId'] } : {}),
      ...(typeof q['executorId'] === 'string' ? { executorId: q['executorId'] } : {}),
      ...(typeof q['status'] === 'string' ? { status: q['status'] } : {}),
      ...(q['since'] !== undefined ? { since: Number(q['since']) } : {}),
    }))
  }))

  // ── strategies / registry ───────────────────────────────────────────────────

  router.get('/api/strategies', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json(runtime.listStrategies())
  }))

  router.get('/api/registry', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json({
      monitors: runtime.listMonitors(),
      executors: runtime.listExecutors(),
      strategies: runtime.listStrategies(),
    })
  }))

  router.post('/api/registry', upload.single('file'), h(async (req, res) => {
    const runtime = await ensureStarted()
    const type = (req.body as Record<string, string>)['type'] as CompiledType | undefined
    const id = (req.body as Record<string, string>)['id']
    if (!type || !['monitors', 'executors', 'strategies'].includes(type)) {
      res.status(400).json({ error: 'Invalid type' }); return
    }
    if (!id || !/^[a-z0-9-_]+$/i.test(id)) {
      res.status(400).json({ error: 'Invalid id (alphanumeric, hyphens, underscores only)' }); return
    }
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return }

    const sourceDir = path.join(dataDirFromEnv(), 'compiled', type, id)
    await fs.promises.mkdir(sourceDir, { recursive: true })
    await fs.promises.writeFile(path.join(sourceDir, 'source.ts'), req.file.buffer.toString('utf8'), 'utf8')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = (runtime as any).compiledLoader as CompiledLoader
    await loader.recompile(id, type)
    res.status(201).json({ ok: true, id, type })
  }))

  router.delete('/api/registry/:type/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    const type = req.params['type'] as CompiledType
    const id = req.params['id']!
    if (!['monitors', 'executors', 'strategies'].includes(type)) {
      res.status(400).json({ error: 'Invalid type' }); return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = (runtime as any).compiledLoader as CompiledLoader
    try {
      const active = runtime.listInstances().filter(i => i.enabled).map(i => i.strategyId)
      await loader.remove(id, type, active)
      res.json({ ok: true })
    } catch (err) {
      res.status(409).json({ error: errText(err) })
    }
  }))

  // ── catalogues (picker data sources) ───────────────────────────────────────

  /**
   * A venue's listed markets, for the symbol picker.
   *
   * Resolved through the KEYLESS adapter cell — market catalogues are public,
   * so a picker works before any credential is stored. The session is duck-
   * typed for fetchMarkets() (same convention as the account detail panels):
   * venues that don't implement it answer 501 and the client degrades to a
   * free-text input.
   */
  /**
   * A contract's leverage brackets: the max leverage allowed at each notional
   * ceiling, ascending.
   *
   * The venue reports these behind a signed endpoint, so this is the only way a
   * caller without credentials can learn the figure a strategy will actually
   * size against — and it is not interchangeable with the market catalogue's
   * limits.leverage.max, which is the TOP bracket and overstates what a large
   * position may use.
   *
   * A venue whose adapter cannot report brackets gets one Infinity-cap bracket
   * at 1x, matching PerpAccount.fetchLeverageTiers — "unknown, stay
   * conservative" rather than a silent maximum.
   */
  router.get('/api/leverage-tiers', h(async (req, res) => {
    const runtime = await ensureStarted()
    const venue = String(req.query['venue'] ?? '')
    const symbol = String(req.query['symbol'] ?? '')
    const kind = String(req.query['kind'] ?? 'exchange/perp')
    if (!venue || !symbol) { res.status(400).json({ error: 'venue and symbol are required' }); return }
    if (!runtime.adapters.has(kind as never, venue)) {
      res.status(404).json({ error: `No "${kind}" adapter for venue "${venue}"` })
      return
    }

    const cacheKey = `${kind}::${venue}::${symbol}`
    const hit = leverageCache.get(cacheKey)
    if (hit && Date.now() - hit.at < LEVERAGE_TTL_MS) { res.json(hit.tiers); return }

    const session = await runtime.adapters.resolve<Record<string, unknown>>(kind as never, venue)
    const fetchTiers = session['fetchLeverageTiers']
    const tiers = typeof fetchTiers === 'function'
      ? await (fetchTiers as (s: string) => Promise<unknown[]>).call(session, symbol)
      : [{ maxNotionalUsd: null, maxLeverage: 1 }]   // null = no ceiling; JSON has no Infinity
    leverageCache.set(cacheKey, { at: Date.now(), tiers })
    res.json(tiers)
  }))

  router.get('/api/markets', h(async (req, res) => {
    const runtime = await ensureStarted()
    const venue = String(req.query['venue'] ?? '')
    const kind = String(req.query['kind'] ?? 'exchange/perp')
    if (!venue) { res.status(400).json({ error: 'venue is required' }); return }
    if (!runtime.adapters.has(kind as never, venue)) {
      res.status(404).json({ error: `No "${kind}" adapter for venue "${venue}"` })
      return
    }

    const cacheKey = `${kind}::${venue}`
    const hit = marketCache.get(cacheKey)
    if (hit && Date.now() - hit.at < MARKET_TTL_MS) { res.json(hit.markets); return }

    const session = await runtime.adapters.resolve<Record<string, unknown>>(kind as never, venue)
    const fetchMarkets = session['fetchMarkets']
    if (typeof fetchMarkets !== 'function') {
      res.status(501).json({ error: `Venue "${venue}" does not publish a market catalogue` })
      return
    }
    const markets = await (fetchMarkets as () => Promise<unknown[]>).call(session)
    marketCache.set(cacheKey, { at: Date.now(), markets })
    res.json(markets)
  }))

  /**
   * Verify a strategy param's chosen values against a venue — advisory, so a
   * venue that cannot answer yields an empty list rather than a failure.
   */
  router.post('/api/strategies/:id/availability', h(async (req, res) => {
    const runtime = await ensureStarted()
    const body = req.body as { field?: string; values?: string[]; venue?: string }
    if (!body.field || !body.venue) { res.status(400).json({ error: 'field and venue are required' }); return }
    try {
      res.json({ verdicts: await runtime.checkParamAvailability(req.params['id']!, body.field, body.values ?? [], body.venue) })
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  // ── monitors ────────────────────────────────────────────────────────────────

  router.get('/api/monitor', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json({ monitors: runtime.listMonitors(), executors: runtime.listExecutors() })
  }))

  router.get('/api/monitor/status', h(async (_req, res) => {
    const runtime = await ensureStarted()
    const statuses = await Promise.all(runtime.listMonitors().map(async (def) => {
      const instance = runtime.getMonitorInstance(def.id)
      const status = instance?.status()
      let dataKeys: string[] = []
      try {
        dataKeys = (await instance?.getReader().keys()) ?? []
      } catch { /* no data dir yet */ }
      return {
        id: def.id,
        name: def.name,
        ...(def.description ? { description: def.description } : {}),
        ...(def.venue ? { venue: def.venue } : {}),
        mode: status?.mode ?? 'unknown',
        activeKeys: status?.activeKeys ?? [],
        wildcardSubscribers: status?.wildcardSubscribers ?? 0,
        ...(status?.backfillingKeys ? { backfillingKeys: status.backfillingKeys } : {}),
        ...(def.supportsBackfill ? { supportsBackfill: true } : {}),
        manualKeys: listManualWatches(def.id),
        ...(instance?.keySchema
          ? { keyFields: BaseStrategy.deriveParamFields(instance.keySchema, z.object({})) ?? [] }
          : def.keyFields ? { keyFields: def.keyFields } : {}),
        dataKeys,
      }
    }))
    res.json(statuses)
  }))

  router.post('/api/monitor/:name/watch', h(async (req, res) => {
    const runtime = await ensureStarted()
    const monitorId = req.params['name']!
    const body = (req.body ?? {}) as { key?: string; params?: Record<string, unknown> }
    try {
      const key = body.params
        ? String(runtime.getMonitorInstance(monitorId)?.keyFor(body.params) ?? '')
        : body.key?.trim() ?? ''
      watchKey(runtime, monitorId, key)
      res.json({ ok: true, key })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.delete('/api/monitor/:name/watch', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      unwatchKey(runtime, req.params['name']!, ((req.body ?? {}) as { key?: string }).key?.trim() ?? '')
      res.json({ ok: true })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.get('/api/monitor/:name/logs', h(async (req, res) => {
    const runtime = await ensureStarted()
    const instance = runtime.getMonitorInstance(req.params['name']!)
    if (!instance) { res.status(404).send('unknown monitor'); return }
    const n = Math.min(1000, Math.max(1, Number(req.query['n']) || 200))
    res.json(recentLogs(instance.monitorName, n))
  }))

  // Plot routes MUST precede the generic :name/:key record route
  router.get('/api/monitor/:name/plots', h(async (req, res) => {
    const runtime = await ensureStarted()
    res.json(runtime.monitorPlots(req.params['name']!))
  }))

  router.get('/api/monitor/:name/plots/:plotId', h(async (req, res) => {
    const runtime = await ensureStarted()
    const key = String(req.query['key'] ?? '')
    if (!key) { res.status(400).json({ error: 'key is required' }); return }
    // 0 = the whole history; otherwise a floor of 10 so a typo cannot ask for
    // a single point. No ceiling: the reader caches per file, and truncating a
    // long-history panel server-side is exactly the surprise this removes.
    const requested = Number(req.query['n'])
    const n = requested === 0 ? 0 : Math.max(10, requested || 500)
    // Repeated ?option= params (multi-select panels) arrive as an array;
    // express gives a bare string for a single one — pass both through and
    // let the runtime resolve against the panel's live option list.
    const raw = req.query['option']
    const option = raw === undefined ? undefined
      : Array.isArray(raw) ? raw.map(String)
      : String(raw)
    try {
      res.json(await runtime.monitorPlotSeries(req.params['name']!, req.params['plotId']!, key, n, option))
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.get('/api/monitor/:name/:key', h(async (req, res) => {
    const runtime = await ensureStarted()
    const monitor = runtime.getMonitor(req.params['name']!)
    if (!monitor) { res.status(404).json({ error: `Monitor not found: ${req.params['name']}` }); return }
    const reader = monitor.getReader()
    const key = req.params['key']!
    const n = Math.min(1000, Math.max(1, Number(req.query['n']) || 50))
    const [records, total] = await Promise.all([reader.readLast(key, n), reader.count(key)])
    res.json({ records, total })
  }))

  // ── monitor instances ───────────────────────────────────────────────────────

  router.get('/api/monitor-instances', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json({
      instances: await runtime.listMonitorInstances(),
      implementations: runtime.listMonitorImplementations(),
      pendingKeys: runtime.monitorPendingKeys(),
    })
  }))

  router.post('/api/monitor-instances', h(async (req, res) => {
    const runtime = await ensureStarted()
    const body = req.body as { implementation: string; name?: string; credential?: string; params?: Record<string, unknown>; activate?: boolean }
    try {
      const entity = await runtime.createMonitorInstance({
        implementation: body.implementation,
        ...(body.name !== undefined && body.name !== '' ? { name: body.name } : {}),
        ...(body.credential !== undefined && body.credential !== '' ? { credential: body.credential } : {}),
        ...(body.params !== undefined ? { params: body.params } : {}),
      })
      if (body.activate !== false) await runtime.activateMonitorInstance(entity.id)
      res.status(201).json(entity)
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.post('/api/monitor-instances/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    const body = req.body as { action: 'activate' | 'deactivate' }
    try {
      if (body.action === 'activate') await runtime.activateMonitorInstance(req.params['id']!)
      else await runtime.deactivateMonitorInstance(req.params['id']!)
      res.json({ ok: true })
    } catch (err) {
      res.status(409).json({ error: errText(err) })
    }
  }))

  router.patch('/api/monitor-instances/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      await runtime.updateMonitorInstanceParams(req.params['id']!, (req.body as { params: Record<string, unknown> }).params)
      res.json({ ok: true })
    } catch (err) {
      res.status(409).json({ error: errText(err) })
    }
  }))

  router.delete('/api/monitor-instances/:id', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      await runtime.deleteMonitorInstance(req.params['id']!)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  // ── monitor data explorer ───────────────────────────────────────────────────

  /*
   * Hyperliquid's public leaderboard, reduced to a handful of copyable
   * traders. Two things make this a server route rather than a fetch from the
   * page: the source is a 34 MB JSON document, and it changes slowly enough
   * that pulling it per visitor would be absurd.
   *
   * Ranked by month PnL over CURRENT EQUITY, not by the `roi` the feed
   * supplies. That field is measured against starting capital, so an account
   * that began near zero shows 28,000% for a 1.5% gain — the top of the
   * leaderboard by roi is a list of rounding errors. Floors on equity and
   * volume keep out the account that turned $200 into $2,000 once.
   */
  const TOP_TRADERS_TTL = 6 * 3600_000
  let topTraders: { at: number; rows: unknown[] } | null = null

  router.get('/api/hyperliquid/top-traders', h(async (_req, res) => {
    if (topTraders && Date.now() - topTraders.at < TOP_TRADERS_TTL) {
      res.json(topTraders.rows)
      return
    }
    try {
      const r = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = await r.json() as {
        leaderboardRows: Array<{
          ethAddress: string
          accountValue: string
          displayName: string | null
          windowPerformances: Array<[string, { pnl: string; roi: string; vlm: string }]>
        }>
      }
      const rows = body.leaderboardRows
        .flatMap((row) => {
          const month = row.windowPerformances.find(([w]) => w === 'month')?.[1]
          if (!month) return []
          const equity = Number(row.accountValue)
          const pnl = Number(month.pnl)
          const volume = Number(month.vlm)
          if (!(equity >= 100_000) || !(volume >= 1_000_000)) return []
          return [{
            address: row.ethAddress,
            ...(row.displayName ? { name: row.displayName } : {}),
            equity, pnl, volume,
            /** Month PnL over current equity. See the note above on `roi`. */
            returnPct: (pnl / equity) * 100,
          }]
        })
        .sort((a, b) => b.returnPct - a.returnPct)
        .slice(0, 12)
      topTraders = { at: Date.now(), rows }
      res.json(rows)
    } catch (err) {
      // Advisory: the field it feeds still takes a typed address.
      res.status(502).json({ error: errText(err) })
    }
  }))

  router.get('/api/monitor-data', h(async (req, res) => {
    const runtime = await ensureStarted()
    const monitorsDir = path.join(runtime.dataDirPath, 'monitors')
    const monitor = req.query['monitor'] as string | undefined
    const key = req.query['key'] as string | undefined

    if (!monitor) {
      const contracts: Array<{ monitor: string; keys: number; bytes: number }> = []
      for (const entry of safeReaddir(monitorsDir)) {
        const dir = path.join(monitorsDir, entry)
        if (!fs.statSync(dir).isDirectory()) continue
        const files = walkJsonl(dir)
        contracts.push({ monitor: entry, keys: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) })
      }
      /*
       * Free space alongside the totals, because the two are the same question.
       * These files only ever grow — a monitor that has been collecting for a
       * month is a monitor quietly filling a disk, and "1155.7 MB" means
       * nothing without knowing what is left. statfs is cheap and advisory:
       * if it is unavailable the listing still renders.
       */
      let disk: { freeBytes: number; totalBytes: number } | undefined
      try {
        const st = await fs.promises.statfs(monitorsDir)
        disk = { freeBytes: st.bsize * st.bavail, totalBytes: st.bsize * st.blocks }
      } catch { /* advisory */ }
      res.json({ dataDir: monitorsDir, contracts, ...(disk ? { disk } : {}) })
      return
    }

    const monitorDir = path.join(monitorsDir, sanitize(monitor))
    if (!monitorDir.startsWith(monitorsDir)) { res.status(400).json({ error: 'bad path' }); return }

    if (!key) {
      const files = walkJsonl(monitorDir)
      res.json({
        keys: files
          .map(f => ({ key: f.key, bytes: f.bytes, updatedAt: f.mtimeMs }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      })
      return
    }

    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100) || 100, 1), 1000)
    const filePath = path.join(monitorDir, ...sanitize(key).split('/')) + '.jsonl'
    if (!filePath.startsWith(monitorDir) || !fs.existsSync(filePath)) {
      res.json({ records: [] })
      return
    }
    res.json({ records: tailRecords(filePath, limit) })
  }))

  // ── monitor retention ───────────────────────────────────────────────────────
  //
  // Pruning is opt-in per store: some monitor files ARE the historical record a
  // strategy fits its baseline against, so nothing is trimmed until an operator
  // names a target and a horizon. Every mutating call is explicit; the sweep
  // that runs hourly only touches policies saved through here.

  router.get('/api/monitor-retention', h(async (_req, res) => {
    await ensureStarted()
    const svc = getRetentionService()
    if (!svc) { res.status(503).json({ error: 'retention service not ready' }); return }
    res.json({ policies: await svc.list() })
  }))

  router.post('/api/monitor-retention', h(async (req, res) => {
    await ensureStarted()
    const svc = getRetentionService()
    if (!svc) { res.status(503).json({ error: 'retention service not ready' }); return }
    try {
      res.json({ policy: await svc.upsert((req.body ?? {}) as Record<string, never>) })
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.delete('/api/monitor-retention/:id', h(async (req, res) => {
    await ensureStarted()
    const svc = getRetentionService()
    if (!svc) { res.status(503).json({ error: 'retention service not ready' }); return }
    await svc.remove(String(req.params['id']))
    res.json({ ok: true })
  }))

  /**
   * What a horizon WOULD cost, without touching a byte. The editor calls this
   * as the operator types, because "keep 7 days" means nothing until you can
   * see it is about to drop 5.4GB from a store you meant to keep.
   */
  router.post('/api/monitor-retention/preview', h(async (req, res) => {
    await ensureStarted()
    const svc = getRetentionService()
    if (!svc) { res.status(503).json({ error: 'retention service not ready' }); return }
    const body = (req.body ?? {}) as { monitor?: string; keyPattern?: string; keepDays?: number }
    const monitor = (body.monitor ?? '').trim()
    const keyPattern = (body.keyPattern ?? '*').trim() || '*'
    const keepDays = Number(body.keepDays)
    if (!monitor || !Number.isFinite(keepDays) || keepDays <= 0) {
      res.status(400).json({ error: 'monitor and a positive keepDays are required' })
      return
    }
    const matched = svc.matches(monitor, keyPattern)
    const summary = await svc.apply({ monitor, keyPattern, keepDays }, true)
    res.json({
      // Absolute paths stay server-side; the client identifies a store by
      // (monitor, key) exactly as the Explorer does.
      matched: matched.map(({ monitor: m, key, bytes, updatedAt }) => ({ monitor: m, key, bytes, updatedAt })),
      summary,
    })
  }))

  router.post('/api/monitor-retention/run', h(async (req, res) => {
    await ensureStarted()
    const svc = getRetentionService()
    if (!svc) { res.status(503).json({ error: 'retention service not ready' }); return }
    const id = (req.body as { id?: string } | undefined)?.id
    try {
      res.json(id ? { summaries: [await svc.runPolicy(id)] } : { summaries: await svc.sweep() })
    } catch (err) {
      res.status(400).json({ error: errText(err) })
    }
  }))

  router.post('/api/monitor-data/open', h(async (req, res) => {
    const runtime = await ensureStarted()
    const body = (req.body ?? {}) as { monitor?: string }
    const root = path.join(runtime.dataDirPath, 'monitors')
    const target = body.monitor ? path.join(root, sanitize(body.monitor)) : root
    if (!target.startsWith(root) || !fs.existsSync(target)) {
      res.status(404).json({ error: 'folder does not exist (no data yet?)' })
      return
    }
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref()
    res.json({ ok: true, path: target })
  }))

  // ── executors ───────────────────────────────────────────────────────────────

  router.get('/api/executor/status', h(async (_req, res) => {
    const runtime = await ensureStarted()
    const executors = runtime.listExecutors().map((def) => {
      const instance = runtime.getExecutorInstance(def.id)
      const actionSchemas = instance?.actionSchemas
      return {
        id: def.id,
        name: def.name,
        ...(def.description ? { description: def.description } : {}),
        supportedActions: def.supportedActions,
        credentialSlots: instance?.credentials ?? [],
        ...(actionSchemas
          ? {
              actionSchemas: Object.fromEntries(
                Object.entries(actionSchemas).map(([a, s]) => [a, JSON.parse(JSON.stringify(z.toJSONSchema(s)))]),
              ),
            }
          : {}),
      }
    })
    res.json(executors)
  }))

  router.post('/api/executor/:name/fire', h(async (req, res) => {
    const runtime = await ensureStarted()
    const body = req.body as { action?: string; params?: Record<string, unknown>; credentials?: Record<string, string> }
    if (!body.action) { res.status(400).send('action is required'); return }
    try {
      const result = await runtime.fireInstruction(req.params['name']!, body.action, body.params ?? {}, body.credentials ?? {})
      res.json(result ?? { status: 'skipped', note: 'action not supported by this executor' })
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.get('/api/executor/:name/logs', h(async (req, res) => {
    const runtime = await ensureStarted()
    const instance = runtime.getExecutorInstance(req.params['name']!)
    if (!instance) { res.status(404).send('unknown executor'); return }
    const n = Math.min(1000, Math.max(1, Number(req.query['n']) || 200))
    res.json(recentLogs(instance.executorName, n))
  }))

  router.get('/api/executor/:name/records', h(async (req, res) => {
    const runtime = await ensureStarted()
    const instance = runtime.getExecutorInstance(req.params['name']!)
    if (!instance) { res.status(404).send('unknown executor'); return }
    const n = Math.min(500, Math.max(1, Number(req.query['n']) || 50))
    const dir = path.join(getDataDir(), 'executions', instance.executorName)
    const records: unknown[] = []
    try {
      const files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().reverse()
      for (const file of files) {
        const lines = (await fs.promises.readFile(path.join(dir, file), 'utf8')).trim().split('\n').filter(Boolean)
        for (const line of lines.reverse()) {
          try { records.push(JSON.parse(line)) } catch { /* skip bad line */ }
          if (records.length >= n) break
        }
        if (records.length >= n) break
      }
    } catch { /* no records yet */ }
    res.json(records.reverse())
  }))

  // ── plugins ─────────────────────────────────────────────────────────────────

  router.get('/api/plugins', h(async (_req, res) => {
    const runtime = await ensureStarted()
    res.json(await listInstalledPlugins(runtime))
  }))

  router.post('/api/plugins', upload.single('file'), h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      if (req.file) {
        const form = req.body as Record<string, string>
        const config = parseConfig(form['config'])
        const view = await installFromFile(runtime, req.file.originalname, req.file.buffer.toString('utf8'), config, form['overwrite'] === 'true', form['alias'] || undefined)
        res.status(201).json(view)
        return
      }
      const body = req.body as { source?: string; package?: string; repo?: string; ref?: string; config?: unknown; overwrite?: boolean; alias?: string }
      const overwrite = body.overwrite === true
      const alias = body.alias?.trim() || undefined
      if (body.source === 'github') {
        if (!body.repo) {
          res.status(400).send('Expected { source: "github", repo: "owner/repo" }')
          return
        }
        const ref = body.ref?.trim()
        res.status(201).json(await installFromGithub(runtime, body.repo.trim(), ref || undefined, body.config ?? {}, overwrite, alias))
        return
      }
      if (body.source !== 'npm' || !body.package) {
        res.status(400).send('Expected { source: "npm", package: "..." } or { source: "github", repo: "..." }')
        return
      }
      const view = await installFromNpm(runtime, body.package.trim(), body.config ?? {}, overwrite, alias)
      // An overwrite unloads the plugins that depend on the replaced one; bring them back
      if (overwrite) await reloadUnloaded(runtime)
      res.status(201).json(view)
    } catch (err) {
      /* A name collision is a question the user can answer, so it comes back
         as structured data rather than prose: 409 with what it collided with,
         which the install form turns into "overwrite?". */
      if (err instanceof PluginConflictError) {
        res.status(409).json({
          conflict: {
            plugin: err.plugin,
            /* sameSource is the difference between "a new version of this" and
               "somebody else's plugin of the same name" — the form needs it to
               know whether to offer overwrite or a namespace. */
            sameSource: err.sameSource,
            suggestedAlias: err.suggestedAlias,
            /* Non-empty = a fresh namespace cannot work, so the form must not
               offer one: both plugins claim something only one can hold. */
            blockedBy: err.blockedBy,
            ...(err.existing ? { source: describeSource(err.existing.source), installedAt: err.existing.installedAt } : {}),
          },
          error: errText(err),
        })
        return
      }
      res.status(400).send(errText(err))
    }
  }))

  /* npm-installed plugins with a newer version on the registry. */
  /* ── Alerting ────────────────────────────────────────────────────────────
     One configuration for the engine. The channels are credentials, so the
     keys are stored encrypted with everything else and nothing here holds a
     secret — only the NAME of a credential and where to send. */
  router.get('/api/alerts/settings', h(async (_req, res) => {
    const alerts = getAlertService()
    res.json(alerts ? alerts.current() : { enabled: false, emailTo: [] })
  }))

  router.put('/api/alerts/settings', h(async (req, res) => {
    const alerts = getAlertService()
    if (!alerts) { res.status(503).send('Alerting is not started yet'); return }
    res.json(await alerts.save(req.body as AlertSettings))
  }))

  /* Send one now, through whatever is configured. The only way to learn that a
     relay accepts the key but refuses the sender, or that a bot was never
     added to its group — both of which look like success until an alert
     matters. Reports per channel rather than one verdict: half-working is the
     interesting state. */
  router.post('/api/alerts/test', h(async (_req, res) => {
    const alerts = getAlertService()
    if (!alerts) { res.status(503).send('Alerting is not started yet'); return }
    const result = await alerts.dispatch(
      'OpenWhale: test alert',
      'This is a test from the Alerts page. If you are reading it, delivery works.',
    )
    if (result.sent.length === 0 && result.failed.length === 0) {
      res.status(400).json({ error: 'Nothing is configured to send to' })
      return
    }
    res.json(result)
  }))

  router.get('/api/plugins/updates', h(async (_req, res) => {
    res.json(await checkPluginUpdates())
  }))

  /* One-click update: overwrite-install the registry version, reload the
     plugins that depended on it, re-activate what was running. */
  router.post('/api/plugins/:name/update', h(async (req, res) => {
    const runtime = await ensureStarted()
    const body = (req.body ?? {}) as { version?: string }
    try {
      res.json(await updatePlugin(runtime, req.params['name']!, body.version?.trim() || undefined))
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  /* What uninstalling would take with it — read before confirming, so the
     dialog can say "this deletes 3 monitor instances" instead of the delete
     being discovered afterwards. */
  router.get('/api/plugins/:name/dependents', h(async (req, res) => {
    const runtime = await ensureStarted()
    res.json(await runtime.pluginDependents(req.params['name']!))
  }))

  router.delete('/api/plugins/:name', h(async (req, res) => {
    const runtime = await ensureStarted()
    try {
      await uninstallPlugin(runtime, req.params['name']!)
      res.json({ ok: true })
    } catch (err) {
      res.status(409).send(errText(err))
    }
  }))

  // ── compiler ────────────────────────────────────────────────────────────────

  router.get('/api/compiler/jobs', h(async (_req, res) => {
    const compiler = await ensureCompiler()
    res.json(await compiler.listJobs())
  }))

  router.post('/api/compiler/jobs', h(async (req, res) => {
    const compiler = await ensureCompiler()
    const body = req.body as { description?: string; target?: string }
    if (!body.description?.trim()) { res.status(400).send('description is required'); return }
    const target = ['auto', 'strategy', 'monitor', 'executor', 'suite'].includes(body.target ?? '') ? body.target : 'auto'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.status(201).json(await compiler.createJob(body.description.trim(), target as any))
  }))

  /**
   * The framework's type surface for the in-browser editor: every .d.ts (and
   * package.json, for "types" resolution) of the packages compiled strategies
   * may import. Monaco registers each under file:///node_modules/<path>, which
   * is what turns highlighting into real framework-aware completions.
   * Heavy (~1.3MB) but immutable per build — cached hard.
   */
  router.get('/api/compiler/typedefs', h(async (_req, res) => {
    const require2 = createRequire(import.meta.url)
    const files: Record<string, string> = {}
    // exports maps rarely expose ./package.json — resolve the entry, then
    // climb to the directory whose package.json carries the package's name.
    const packageRoot = (pkg: string): string | undefined => {
      let dir: string
      try {
        dir = path.dirname(require2.resolve(pkg))
      } catch {
        return undefined
      }
      for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'package.json')
        try {
          if ((JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string }).name === pkg) return dir
        } catch { /* keep climbing */ }
        dir = path.dirname(dir)
      }
      return undefined
    }
    for (const pkg of ['@openwhaleorg/core', '@openwhaleorg/exchange', 'zod']) {
      const root = packageRoot(pkg)
      if (!root) continue
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'src') continue
            walk(full)
          } else if (entry.name.endsWith('.d.ts') || (entry.name === 'package.json' && dir === root)) {
            files[`${pkg}/${path.relative(root, full)}`] = fs.readFileSync(full, 'utf8')
          }
        }
      }
      walk(root)
    }
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.json(files)
  }))

  router.get('/api/compiler/settings', h(async (_req, res) => {
    const compiler = await ensureCompiler()
    res.json(compiler.getSettings())
  }))

  router.put('/api/compiler/settings', h(async (req, res) => {
    const compiler = await ensureCompiler()
    try {
      await compiler.saveSettings(req.body as CompilerSettings)
      res.json(compiler.getSettings())
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  router.get('/api/compiler/jobs/:id', h(async (req, res) => {
    const compiler = await ensureCompiler()
    const job = await compiler.getJob(req.params['id']!)
    if (!job) { res.status(404).send('not found'); return }
    res.json(job)
  }))

  router.delete('/api/compiler/jobs/:id', h(async (req, res) => {
    const compiler = await ensureCompiler()
    await compiler.deleteJob(req.params['id']!)
    res.json({ ok: true })
  }))

  router.post('/api/compiler/jobs/:id', h(async (req, res) => {
    const compiler = await ensureCompiler()
    const id = req.params['id']!
    const body = req.body as Record<string, unknown> & { action?: string }
    try {
      switch (body.action) {
        case 'confirm':
          await compiler.confirmAnalysis(id, body['note'] as string | undefined)
          res.json({ ok: true }); return
        case 'message':
          await compiler.sendMessage(id, String(body['feedback'] ?? ''))
          res.json({ ok: true }); return
        case 'code':
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await compiler.updateCode(id, body['files'] as any)
          res.json({ ok: true }); return
        case 'approve': {
          const result = await compiler.approve(id, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(body['idOverrides'] ? { idOverrides: body['idOverrides'] as any } : {}),
            ...(body['acknowledgeExecutorRisk'] ? { acknowledgeExecutorRisk: true } : {}),
          })
          res.json(result); return
        }
        default:
          res.status(400).send(`unknown action "${body.action}"`)
      }
    } catch (err) {
      res.status(400).send(errText(err))
    }
  }))

  // ── events (SSE) ────────────────────────────────────────────────────────────

  router.get('/api/events', h(async (req, res) => {
    const runtime = await ensureStarted()
    sseHandler(runtime, getCompilerService())(req, res)
  }))

  return router
}

// ── helpers ───────────────────────────────────────────────────────────────────

function dataDirFromEnv(): string {
  return process.env['OPENWHALE_DB_PATH']
    ? path.dirname(process.env['OPENWHALE_DB_PATH'])
    : path.join(os.homedir(), '.openwhale')
}

function parseConfig(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  return JSON.parse(raw)
}

function sanitize(value: string): string {
  return value.split('/').filter(seg => seg !== '..' && seg !== '').join('/')
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function walkJsonl(dir: string, prefix = ''): Array<{ key: string; bytes: number; mtimeMs: number }> {
  const out: Array<{ key: string; bytes: number; mtimeMs: number }> = []
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkJsonl(full, `${prefix}${entry}/`))
    } else if (entry.endsWith('.jsonl')) {
      out.push({ key: decodeMonitorKey(`${prefix}${entry.slice(0, -6)}`), bytes: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  return out
}

function tailRecords(filePath: string, limit: number): Array<Record<string, unknown>> {
  const stat = fs.statSync(filePath)
  const WINDOW = 512 * 1024
  let text: string
  if (stat.size <= WINDOW) {
    text = fs.readFileSync(filePath, 'utf8')
  } else {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(WINDOW)
      fs.readSync(fd, buf, 0, WINDOW, stat.size - WINDOW)
      text = buf.toString('utf8')
      text = text.slice(text.indexOf('\n') + 1)
    } finally {
      fs.closeSync(fd)
    }
  }
  const lines = text.split('\n').filter(l => l.trim() !== '')
  const records: Array<Record<string, unknown>> = []
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // torn write at the tail — skip
    }
  }
  return records.reverse()
}
