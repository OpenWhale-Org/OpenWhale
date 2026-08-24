/**
 * Plugin installation service.
 *
 * Layering: core's runtime owns the loading MECHANISM (loadPluginFromPath /
 * unloadPlugin / namespacing). This module owns ACQUISITION and PERSISTENCE —
 * where plugin code comes from (npm / uploaded file), the install manifest,
 * and restoring installed plugins on boot. The runtime never learns what a
 * package manager is.
 *
 * Layout under {dataDir}/plugins/:
 *   package.json + node_modules/   npm-installed plugins
 *   local/                         uploaded single-file plugin bundles
 *   plugins.json                   install manifest (source, entry, config)
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { OpenWhaleRuntime, LoadedPluginInfo } from '@openwhaleorg/core'
import { getLogger } from '@openwhaleorg/core'

const execFileAsync = promisify(execFile)
const log = () => getLogger().child({ module: 'PluginService' })

export type PluginSource =
  | { kind: 'npm'; package: string }
  | { kind: 'local'; path: string; packageName: string }
  | { kind: 'file'; originalName: string }

export interface PluginManifestEntry {
  /** Plugin namespace (OpenWhalePlugin.name), known after first load. */
  name: string
  source: PluginSource
  /** Absolute path of the module loaded via runtime.loadPluginFromPath. */
  entryPath: string
  config: unknown
  installedAt: string
}

export interface InstalledPluginView extends LoadedPluginInfo {
  source?: PluginSource
  installedAt?: string
  /** True when the manifest entry failed to load on boot. */
  loadError?: string
}

function getDataDir(): string {
  return process.env['OPENWHALE_DB_PATH']
    ? path.dirname(process.env['OPENWHALE_DB_PATH'])
    : path.join(os.homedir(), '.openwhale')
}

function getPluginsDir(): string {
  return path.join(getDataDir(), 'plugins')
}

function getManifestPath(): string {
  return path.join(getPluginsDir(), 'plugins.json')
}

// Boot-time load failures, keyed by plugin name, surfaced in the list view
const loadErrors = new Map<string, string>()

async function readManifest(): Promise<PluginManifestEntry[]> {
  try {
    const raw = await fs.promises.readFile(getManifestPath(), 'utf8')
    return JSON.parse(raw) as PluginManifestEntry[]
  } catch {
    return []
  }
}

async function writeManifest(entries: PluginManifestEntry[]): Promise<void> {
  await fs.promises.mkdir(getPluginsDir(), { recursive: true })
  await fs.promises.writeFile(getManifestPath(), JSON.stringify(entries, null, 2), 'utf8')
}

async function upsertManifest(entry: PluginManifestEntry): Promise<void> {
  const entries = await readManifest()
  const next = entries.filter(e => e.name !== entry.name)
  next.push(entry)
  await writeManifest(next)
}

// ── npm install ───────────────────────────────────────────────────────────────

/** '@scope/name@^1.0.0' → { packageName: '@scope/name', spec: original } */
function parsePackageSpec(spec: string): { packageName: string } {
  const at = spec.lastIndexOf('@')
  const packageName = at > 0 ? spec.slice(0, at) : spec
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(packageName)) {
    throw new Error(`Invalid npm package name: "${packageName}"`)
  }
  return { packageName }
}

/**
 * An absolute directory path or file: spec pointing at a local package.
 * Absolute forms of every platform count — POSIX (`/abs/pkg`), Windows drive
 * (`D:\pkg`, `D:/pkg`) and UNC (`\\server\share\pkg`) — classified
 * identically on every OS via the per-platform stdlib parsers. Relative and
 * drive-relative paths (`../pkg`, `D:pkg`) stay rejected.
 */
export function asLocalPath(spec: string): string | undefined {
  const raw = spec.startsWith('file:') ? spec.slice(5) : spec
  const isAbsolute = path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)
  if (!isAbsolute && !raw.startsWith('~')) return undefined
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw
}

/**
 * npm's spawn form for execFile. On Windows `npm` is a .cmd shim, which
 * execFile cannot run — CreateProcess does no PATHEXT resolution, and newer
 * Node rejects .cmd without a shell outright (spawn EINVAL) — so npm's CLI
 * entry is invoked with the current Node binary instead.
 */
export function npmSpawn(): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: 'npm', args: [] }
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(cli)) {
    throw new Error(
      `npm CLI not found at "${cli}" — npm ships with Node, so it is expected ` +
        `next to the running binary (${process.execPath})`,
    )
  }
  return { file: process.execPath, args: [cli] }
}

/** Read the package name from a local package dir; validates it looks like a package. */
function localPackageName(dir: string): string {
  let pkg: { name?: string }
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
  } catch {
    throw new Error(`"${dir}" is not a package directory (no readable package.json)`)
  }
  if (!pkg.name) throw new Error(`"${dir}/package.json" has no "name"`)
  return pkg.name
}

/** Resolve a package's ESM entry from its package.json (exports > module > main). */
function resolveEntry(pkgDir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    exports?: unknown
    module?: string
    main?: string
  }
  let entry: string | undefined
  const exp = pkg.exports
  if (typeof exp === 'string') {
    entry = exp
  } else if (exp && typeof exp === 'object') {
    const dot = (exp as Record<string, unknown>)['.']
    if (typeof dot === 'string') entry = dot
    else if (dot && typeof dot === 'object') {
      const d = dot as Record<string, unknown>
      entry = (d['import'] ?? d['default']) as string | undefined
      if (entry && typeof entry === 'object') entry = (entry as Record<string, string>)['default']
    }
  }
  entry = entry ?? pkg.module ?? pkg.main ?? 'index.js'
  return path.join(pkgDir, entry)
}

/**
 * Install a plugin from npm into the managed plugins dir and load it.
 * ⚠️ Installing a package executes third-party code in this process.
 */
export async function installFromNpm(
  runtime: OpenWhaleRuntime,
  spec: string,
  config: unknown,
): Promise<InstalledPluginView> {
  // Local package directory: npm symlinks it, so rebuilding the package and
  // restarting picks up changes — the dev loop for unpublished plugins.
  const localPath = asLocalPath(spec)
  const packageName = localPath ? localPackageName(localPath) : parsePackageSpec(spec).packageName
  const pluginsDir = getPluginsDir()
  await fs.promises.mkdir(pluginsDir, { recursive: true })

  // A stub package.json keeps npm from walking up to the repo's workspace
  const stubPath = path.join(pluginsDir, 'package.json')
  try {
    await fs.promises.access(stubPath)
  } catch {
    await fs.promises.writeFile(stubPath, JSON.stringify({ name: 'openwhale-plugins', private: true }, null, 2))
  }

  log().info({ spec, local: Boolean(localPath) }, 'Installing plugin')
  const npm = npmSpawn()
  await execFileAsync(npm.file, [...npm.args, 'install', localPath ?? spec, '--prefix', pluginsDir, '--no-audit', '--no-fund', '--loglevel=error'], {
    timeout: 300_000,
  })

  const entryPath = resolveEntry(path.join(pluginsDir, 'node_modules', packageName))
  const name = await runtime.loadPluginFromPath(entryPath, config)

  const source: PluginSource = localPath
    ? { kind: 'local', path: localPath, packageName }
    : { kind: 'npm', package: spec }
  await upsertManifest({
    name,
    source,
    entryPath,
    config,
    installedAt: new Date().toISOString(),
  })
  loadErrors.delete(name)

  const info = runtime.listLoadedPlugins().find(p => p.name === name)!
  return { ...info, source }
}

// ── file install ──────────────────────────────────────────────────────────────

/**
 * Install a plugin from an uploaded single-file JS bundle (built, ESM,
 * default-exporting a PluginFactory). TypeScript sources must be built first —
 * a plugin usually has dependencies, which only the npm path can carry.
 */
export async function installFromFile(
  runtime: OpenWhaleRuntime,
  originalName: string,
  content: string,
  config: unknown,
): Promise<InstalledPluginView> {
  if (!/\.(mjs|js)$/i.test(originalName)) {
    throw new Error('Only built .js/.mjs bundles are supported for file install — for TypeScript sources or plugins with dependencies, publish to npm and install by package name')
  }
  const localDir = path.join(getPluginsDir(), 'local')
  await fs.promises.mkdir(localDir, { recursive: true })

  const base = path.basename(originalName).replace(/[^\w.-]/g, '_').replace(/\.(mjs|js)$/i, '')
  const entryPath = path.join(localDir, `${base}-${Date.now()}.mjs`)
  await fs.promises.writeFile(entryPath, content, 'utf8')

  let name: string
  try {
    name = await runtime.loadPluginFromPath(entryPath, config)
  } catch (err) {
    await fs.promises.rm(entryPath, { force: true })
    throw err
  }

  await upsertManifest({
    name,
    source: { kind: 'file', originalName },
    entryPath,
    config,
    installedAt: new Date().toISOString(),
  })
  loadErrors.delete(name)

  const info = runtime.listLoadedPlugins().find(p => p.name === name)!
  return { ...info, source: { kind: 'file', originalName } }
}

// ── uninstall ─────────────────────────────────────────────────────────────────

export async function uninstallPlugin(runtime: OpenWhaleRuntime, name: string): Promise<void> {
  // Throws if active instances still use the plugin's strategies.
  // A plugin that failed to load on boot has nothing registered — skip unload.
  const isLoaded = runtime.listLoadedPlugins().some(p => p.name === name)
  if (isLoaded) runtime.unloadPlugin(name)

  const entries = await readManifest()
  const entry = entries.find(e => e.name === name)
  await writeManifest(entries.filter(e => e.name !== name))
  loadErrors.delete(name)
  if (!entry) return

  if (entry.source.kind === 'npm' || entry.source.kind === 'local') {
    const packageName = entry.source.kind === 'local' ? entry.source.packageName : parsePackageSpec(entry.source.package).packageName
    try {
      const npm = npmSpawn()
      await execFileAsync(npm.file, [...npm.args, 'uninstall', packageName, '--prefix', getPluginsDir(), '--loglevel=error'], { timeout: 120_000 })
    } catch (err) {
      log().warn({ name, err }, 'npm uninstall failed — manifest entry removed anyway')
    }
  } else {
    await fs.promises.rm(entry.entryPath, { force: true })
  }
}

// ── boot restore & listing ────────────────────────────────────────────────────

/** Load every manifest entry. One broken plugin must not block the others. */
export async function restorePlugins(runtime: OpenWhaleRuntime): Promise<void> {
  const entries = await readManifest()
  for (const entry of entries) {
    if (runtime.listLoadedPlugins().some(p => p.name === entry.name)) continue
    try {
      await runtime.loadPluginFromPath(entry.entryPath, entry.config)
      loadErrors.delete(entry.name)
      log().info({ plugin: entry.name }, 'Restored plugin')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loadErrors.set(entry.name, message)
      log().error({ plugin: entry.name, err }, 'Failed to restore plugin — skipping')
    }
  }
}

/** Loaded plugins merged with manifest metadata, plus manifest entries that failed to load. */
export async function listInstalledPlugins(runtime: OpenWhaleRuntime): Promise<InstalledPluginView[]> {
  const manifest = await readManifest()
  const byName = new Map(manifest.map(e => [e.name, e]))

  const views: InstalledPluginView[] = runtime.listLoadedPlugins().map(p => {
    const entry = byName.get(p.name)
    return {
      ...p,
      ...(entry?.source !== undefined ? { source: entry.source } : {}),
      ...(entry?.installedAt !== undefined ? { installedAt: entry.installedAt } : {}),
    }
  })

  for (const entry of manifest) {
    if (views.some(v => v.name === entry.name)) continue
    views.push({
      name: entry.name,
      version: '—',
      monitors: [], executors: [], strategies: [], accounts: [], scripts: [], kinds: [], credentialTypes: [], cells: [],
      source: entry.source,
      installedAt: entry.installedAt,
      loadError: loadErrors.get(entry.name) ?? 'Not loaded',
    })
  }
  return views
}
