/**
 * Plugin installation service.
 *
 * Layering: core's runtime owns the loading MECHANISM (loadPluginFromPath /
 * unloadPlugin / namespacing). This module owns ACQUISITION and PERSISTENCE —
 * where plugin code comes from (npm / GitHub / uploaded file), the install
 * manifest, and restoring installed plugins on boot. The runtime never learns
 * what a package manager is.
 *
 * Layout under {dataDir}/plugins/:
 *   package.json + node_modules/   npm- and GitHub-installed plugins
 *   local/                         uploaded single-file plugin bundles
 *   plugins.json                   install manifest (source, entry, config)
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { createRequire } from 'module'
import { promisify } from 'util'
import type { OpenWhaleRuntime, LoadedPluginInfo, PluginReplaceResult, PluginGlobalConflict } from '@openwhaleorg/core'
import { getLogger, PluginAlreadyLoadedError } from '@openwhaleorg/core'

const execFileAsync = promisify(execFile)
const log = () => getLogger().child({ module: 'PluginService' })

export type PluginSource =
  | { kind: 'npm'; package: string }
  /** `repo` is always `owner/name`; `packageName` is what package.json calls
      itself, which is NOT derivable from the repo name and so must be kept. */
  | { kind: 'github'; repo: string; ref?: string; packageName: string }
  | { kind: 'local'; path: string; packageName: string }
  | { kind: 'file'; originalName: string }

export interface PluginManifestEntry {
  /** The namespace this install occupies — the key everything addresses it by. */
  name: string
  /**
   * Set when the namespace was chosen at install rather than taken from the
   * package, i.e. this is somebody else's plugin of the same name. Kept
   * because every later load has to reproduce it — the ids in the user's
   * instances are built from it.
   */
  alias?: string
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
  /** Set on an install response that overwrote an already-loaded plugin. */
  replace?: PluginReplaceResult
}

/**
 * Raised when an install turns out to be a second copy of a plugin already
 * loaded — carrying the entry it collides with, so the answer can be "this is
 * already installed from npm, overwrite it?" rather than a refusal.
 *
 * The collision is on the plugin's NAME, which only exists once its factory
 * has run, so this is discovered after acquisition rather than before. That
 * costs nothing: the running plugin executes from its own staged copy, so
 * whatever npm did to node_modules on the way here left it untouched.
 */
export class PluginConflictError extends Error {
  constructor(
    /** The namespace already taken. */
    readonly plugin: string,
    readonly existing: PluginManifestEntry | undefined,
    /**
     * Whether the incoming package is the SAME artefact as the installed one.
     *
     * The whole question in one flag. Plugin names are not globally unique —
     * two authors can each publish a `funding-arb` — so a name collision alone
     * says nothing about whether this is a new version or a stranger. Where it
     * came from does: the same npm package or the same repo is an upgrade,
     * anything else is a different plugin that needs a namespace of its own.
     */
    readonly sameSource: boolean,
    /** A free namespace to offer when it is a different plugin. */
    readonly suggestedAlias: string,
    /**
     * Non-namespaced registrations another plugin already holds. When this is
     * non-empty a fresh namespace is not an option, so it must not be offered:
     * both plugins claim something only one can have.
     */
    readonly blockedBy: PluginGlobalConflict[] = [],
  ) {
    super(
      sameSource
        ? `"${plugin}" is already installed from the same source${existing ? ` (${describeSource(existing.source)})` : ''}` +
            ' — install again with overwrite to replace it.'
        : blockedBy.length > 0
          ? `"${plugin}" and the plugin already installed under that name both provide ` +
              `${blockedBy.map(c => `${c.what} ${c.name}`).join(', ')}, which only one plugin can hold. ` +
              'They cannot both be installed — overwrite the installed one, or uninstall it first.'
          : `The namespace "${plugin}" is taken${existing ? ` by an install from ${describeSource(existing.source)}` : ''}.` +
              ` This package came from somewhere else, so it is a different plugin sharing a name — install it as "${suggestedAlias}",` +
              ' or overwrite if it really is the same plugin that moved.',
    )
    this.name = 'PluginConflictError'
  }
}

/**
 * Where a source points, as one comparable string.
 *
 * Compared instead of the plugin name because the name is what collided.
 *
 * The PACKAGE NAME is the identity, not the kind of source it arrived
 * through, so a checkout at /Users/me/openwhale-pendle and the published
 * `@openwhaleorg/pendle` are one plugin — which is the whole developer
 * workflow: install the local build, later install the release over it. Told
 * apart by source kind, that install is offered a namespace of its own, and
 * then fails anyway on the venue cells it re-registers.
 *
 * Version and branch are left out for the same reason: `funding-arb@2` over
 * `@1`, or a repo on a different tag, is the same plugin.
 */
function sourceIdentity(source: PluginSource): string {
  // An uploaded bundle declares no package, so its filename is all there is
  return packageNameOf(source) ?? `file:${source.kind === 'file' ? source.originalName : ''}`
}

/** Whoever published it — the half of a source that makes a good namespace prefix. */
function ownerOf(source: PluginSource): string | undefined {
  switch (source.kind) {
    case 'github': return source.repo.split('/')[0]
    case 'npm': {
      const scope = /^@([^/]+)\//.exec(source.package)
      return scope?.[1]
    }
    case 'local': return path.basename(path.dirname(source.path))
    case 'file': return undefined
  }
}

/**
 * A namespace nothing is using yet, for the second plugin of a given name.
 *
 * Prefers the publisher — `alice-funding-arb` says whose it is at a glance,
 * which matters because from here on that string is what the user sees on
 * every strategy the plugin provides.
 */
export function suggestAlias(declared: string, source: PluginSource, taken: Iterable<string>): string {
  const used = new Set(taken)
  const clean = (v: string) => v.replace(/[^\w.-]/g, '-').replace(/^-+|-+$/g, '')
  const owner = ownerOf(source)
  const preferred = owner ? `${clean(owner)}-${clean(declared)}` : ''
  if (preferred && !used.has(preferred)) return preferred
  for (let n = 2; ; n++) {
    const candidate = `${clean(declared)}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

export function describeSource(source: PluginSource): string {
  switch (source.kind) {
    case 'npm': return `npm: ${source.package}`
    case 'github': return `github: ${source.repo}${source.ref !== undefined ? `#${source.ref}` : ''}`
    case 'local': return `local: ${source.path}`
    case 'file': return `file: ${source.originalName}`
  }
}

/** The npm package a source installed, if it went through npm at all. */
function packageNameOf(source: PluginSource): string | undefined {
  switch (source.kind) {
    case 'npm': return parsePackageSpec(source.package).packageName
    case 'github':
    case 'local': return source.packageName
    case 'file': return undefined
  }
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
    // A repo URL in the npm field is a mistake worth naming, not a bad package name
    if (/github\.com|^github:|^git[@+]/i.test(spec)) {
      throw new Error(`"${spec}" is a Git repository, not an npm package — install it from the GitHub tab instead`)
    }
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

/**
 * Make sure the managed plugins dir exists and owns a package.json.
 *
 * The stub is what stops npm walking up the tree — without it, installing
 * into a dir under a checkout makes npm treat that checkout's workspace as
 * the install root and rewrite its lockfile.
 */
async function ensureStub(): Promise<void> {
  const pluginsDir = getPluginsDir()
  await fs.promises.mkdir(pluginsDir, { recursive: true })
  const stubPath = path.join(pluginsDir, 'package.json')
  try {
    await fs.promises.access(stubPath)
  } catch {
    await fs.promises.writeFile(stubPath, JSON.stringify({ name: 'openwhale-plugins', private: true }, null, 2))
  }
}

/** The stub's `dependencies` map — npm's own record of what is installed. */
async function stubDeps(): Promise<Record<string, string>> {
  try {
    const raw = await fs.promises.readFile(path.join(getPluginsDir(), 'package.json'), 'utf8')
    return (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {}
  } catch {
    return {}
  }
}

const load = createRequire(import.meta.url)

/** The directory of a package as the ENGINE resolves it, if it provides one at all. */
function enginePackageRoot(name: string): string | undefined {
  let dir: string
  try {
    dir = path.dirname(load.resolve(name))
  } catch {
    return undefined   // not something the engine ships
  }
  for (let up = dir; ; up = path.dirname(up)) {
    const manifest = path.join(up, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        if ((JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return up
      } catch { /* keep walking */ }
    }
    if (path.dirname(up) === up) return undefined
  }
}

/**
 * Whether the engine's copy may stand in for the one npm fetched — the
 * ecosystem's own caret rule, including 0.x where the minor acts as the major,
 * and then one more condition the caret does not supply.
 *
 * The substitution only goes one way. The engine's copy REPLACES the fetched
 * one, so it has to be at least as new: a plugin built against 0.2.2 and
 * importing something 0.2.2 added is caret-compatible with an engine on 0.2.1
 * and imports nothing that engine has. Semver is a promise about what a later
 * version keeps, not about what an earlier one already had, and reading it in
 * the wrong direction turns a published patch into `does not provide an export
 * named 'esc'` at load time — pointing at the plugin, which is fine, rather
 * than at the engine, which is behind.
 *
 * Downward is still allowed, and has to be: npm resolves the plugin's range to
 * the newest version there is, so the fetched copy is routinely a patch ahead
 * of an engine that is otherwise perfectly able to serve it. Refusing those
 * would leave a second framework copy in the tree, which is the whole thing
 * this prevents. Only ahead-of-the-engine is refused, and it is refused loudly:
 * the answer is to update the engine, and nothing else will do.
 */
function caretCompatible(engine: string, fetched: string): boolean {
  const a = engine.split('.').map(Number)
  const b = fetched.split('.').map(Number)
  if (a.length < 3 || b.length < 3 || [...a, ...b].some(Number.isNaN)) return engine === fetched
  if (a[0] !== b[0]) return false
  // 0.x: a minor bump is a breaking change, so it has to match too
  if (a[0] === 0 && a[1] !== b[1]) return false
  return !engineIsOlder(engine, fetched)
}

/**
 * Numerically, because these are versions and not strings: '0.2.10' sorts
 * before '0.2.9' as text and after it as a version, and the whole point of the
 * comparison is which one has the exports the other lacks.
 */
function engineIsOlder(engine: string, fetched: string): boolean {
  const a = engine.split('.').map(Number)
  const b = fetched.split('.').map(Number)
  if (a.length < 3 || b.length < 3 || [...a, ...b].some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }
  return false
}

function versionAt(dir: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}

/**
 * Point framework packages npm dragged in back at the engine's own copies.
 *
 * A plugin declares `@openwhaleorg/core` as a PEER because it must share the
 * engine's copy — the registries, definePlugin, the decorators' metadata and
 * every base class are module-level state, and two copies are two universes: a
 * plugin would register into tables nobody reads. But npm satisfies a missing
 * peer by downloading one, so installing a plugin from the registry quietly
 * produced exactly the second copy the peer declaration existed to prevent.
 *
 * npm cannot be told "this peer is already satisfied by the program doing the
 * installing", so it is corrected afterwards: whatever it fetched is replaced
 * by a link to what the engine is actually running. Node resolves a symlink to
 * its realpath, so the plugin then imports the very module object the engine
 * holds.
 *
 * A version mismatch is left alone and reported. That is a real incompatibility
 * — the plugin asked for something this engine is not — and silently swapping
 * in a different version would turn a legible install failure into a puzzling
 * runtime one.
 */
export async function shareEnginePackages(): Promise<void> {
  const scope = path.join(getPluginsDir(), 'node_modules', '@openwhaleorg')
  let entries: string[]
  try {
    entries = await fs.promises.readdir(scope)
  } catch {
    return
  }

  for (const entry of entries) {
    const installed = path.join(scope, entry)
    const stat = await fs.promises.lstat(installed).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) continue   // already pointing somewhere of ours

    const name = `@openwhaleorg/${entry}`
    const ours = enginePackageRoot(name)
    if (ours === undefined) continue               // a plugin's own package, not a framework one

    const engineVersion = versionAt(ours)
    const fetched = versionAt(installed)
    if (engineVersion === undefined || fetched === undefined) continue
    if (!caretCompatible(engineVersion, fetched)) {
      log().warn(
        { package: name, engine: engineVersion, installed: fetched },
        engineIsOlder(engineVersion, fetched)
          ? 'A plugin resolved a framework version newer than this engine — leaving its own copy, but the two cannot share state, and anything the plugin imports from the newer version will fail to load. Update the engine.'
          : 'A plugin wants a framework version this engine does not provide — leaving its own copy, but the two cannot share state',
      )
      continue
    }

    await fs.promises.rm(installed, { recursive: true, force: true })
    await fs.promises.symlink(ours, installed, 'junction')
    log().info({ package: name, version: engineVersion }, 'Pointed a plugin dependency at the engine\'s own copy')
  }
}

/**
 * Where a package is copied to be loaded from.
 *
 * Node's ESM registry is keyed by resolved URL and can never be evicted, so
 * loading every version of a plugin from the same `node_modules/<pkg>` path
 * means the FIRST version installed in this process is the one that runs,
 * for good. Uninstalling and reinstalling changes the bytes on disk and
 * changes nothing about what executes — silently, which is the worst way for
 * a trading engine to be wrong about which code it is running.
 *
 * A cache-busting query on the entry URL is not enough: it refreshes the
 * entry and leaves every sibling it imports cached, and a plugin's `dist/` is
 * many files. Only a path the loader has never seen gives a whole fresh
 * module graph — so each install copies the package to its own directory.
 *
 * `node_modules` is left behind by the copy on purpose: a plugin's own
 * dependencies were installed into the shared prefix, which is still an
 * ancestor of the staging dir, so resolution finds them there — and a local
 * dev package's tree would otherwise be copied in full, every install.
 */
const STAGE_DIR = 'staged'

/** '@scope/name' → '@scope-name', usable as one directory component. */
function stageName(packageName: string): string {
  return packageName.replace(/[/\\]/g, '-').replace(/[^\w.@-]/g, '_')
}

/** The staging directory an entry path sits in, or undefined if it is not staged. */
export function stagedDirOf(entryPath: string): string | undefined {
  const root = path.join(getPluginsDir(), STAGE_DIR)
  const rel = path.relative(root, entryPath)
  // Refuse anything that escapes the staging root — this path gets rm -rf'd
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const first = rel.split(path.sep)[0]
  return first ? path.join(root, first) : undefined
}

/** Copy the installed package to a directory the module loader has not seen. */
export async function stage(packageName: string, hint?: string): Promise<{ entryPath: string; dir: string }> {
  const pluginsDir = getPluginsDir()
  // realpath: a local install is a symlink into the user's working copy
  const installed = fs.realpathSync(path.join(pluginsDir, 'node_modules', packageName))
  // Resolve against the original first, so a package that was never built
  // fails before anything is copied
  const rel = path.relative(installed, resolveEntry(installed, hint))

  const dir = path.join(pluginsDir, STAGE_DIR, `${stageName(packageName)}-${Date.now()}`)
  await fs.promises.mkdir(path.dirname(dir), { recursive: true })
  await fs.promises.cp(installed, dir, {
    recursive: true,
    dereference: true,
    filter: src => {
      const base = path.basename(src)
      if (base === 'node_modules' || base === '.git') return false
      /* Skip what cannot be followed. The copy dereferences, so one dangling
         symlink anywhere in the package aborts the whole install with an
         ENOENT naming a path the user never chose — and a package is not
         responsible for every link some other tool left inside its directory. */
      return fs.existsSync(src)
    },
  })
  // The copy carries no node_modules. An npm install's dependencies sit flat
  // in the plugins dir and resolve by walking up; a local package's sit in
  // its own node_modules (pnpm's, full of relative symlinks that a copy would
  // break), so point the copy back at them rather than copying them.
  const ownModules = path.join(installed, 'node_modules')
  if (fs.existsSync(ownModules)) await fs.promises.symlink(ownModules, path.join(dir, 'node_modules'), 'dir')
  return { entryPath: path.join(dir, rel), dir }
}

/** Drop this package's earlier staging directories, keeping the live one. */
export async function pruneStaged(packageName: string, keep: string): Promise<void> {
  const root = path.join(getPluginsDir(), STAGE_DIR)
  const prefix = `${stageName(packageName)}-`
  let entries: string[]
  try {
    entries = await fs.promises.readdir(root)
  } catch {
    return
  }
  for (const name of entries) {
    const dir = path.join(root, name)
    if (!name.startsWith(prefix) || dir === keep) continue
    // The module graph is already in memory; the files are only disk
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Stage, load, record — the tail every package-shaped install shares.
 *
 * Pruning happens only after the manifest is written: a failed load must
 * leave the previous staging directory intact, or the manifest entry still
 * pointing at it would fail to restore on the next boot.
 */
async function stageLoadAndRecord(
  runtime: OpenWhaleRuntime,
  packageName: string,
  source: PluginSource,
  config: unknown,
  overwrite: boolean,
  alias: string | undefined,
  hint?: string,
): Promise<InstalledPluginView> {
  const before = await readManifest()
  const { entryPath, dir } = await stage(packageName, hint)
  let loaded: { name: string; alias?: string; replace?: PluginReplaceResult }
  try {
    loaded = await loadOrReplace(runtime, entryPath, config, { overwrite, alias, source, manifest: before })
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return record(runtime, loaded, source, entryPath, config, before, { packageName, dir })
}

/**
 * Load, or load over what is already there.
 *
 * Without `overwrite` a name collision is a question, not a failure — the
 * caller gets the entry it collided with so the user can answer it.
 */
async function loadOrReplace(
  runtime: OpenWhaleRuntime,
  entryPath: string,
  config: unknown,
  ctx: { overwrite: boolean; alias?: string | undefined; source: PluginSource; manifest: PluginManifestEntry[] },
): Promise<{ name: string; alias?: string; replace?: PluginReplaceResult }> {
  const opts = ctx.alias !== undefined ? { as: ctx.alias } : undefined
  const alias = ctx.alias !== undefined ? { alias: ctx.alias } : {}
  if (ctx.overwrite) {
    const replace = await runtime.replacePluginFromPath(entryPath, config, opts)
    return { name: replace.name, ...alias, replace }
  }
  try {
    return { name: await runtime.loadPluginFromPath(entryPath, config, opts), ...alias }
  } catch (err) {
    if (err instanceof PluginAlreadyLoadedError) {
      const existing = ctx.manifest.find(e => e.name === err.pluginName)
      const declared = err.declaredName ?? err.pluginName
      throw new PluginConflictError(
        err.pluginName,
        existing,
        existing !== undefined && sourceIdentity(existing.source) === sourceIdentity(ctx.source),
        suggestAlias(declared, ctx.source, runtime.listLoadedPlugins().map(p => p.name)),
        err.blockedBy,
      )
    }
    throw err
  }
}

/** Write the manifest and clear away whatever the install replaced. */
async function record(
  runtime: OpenWhaleRuntime,
  loaded: { name: string; alias?: string; replace?: PluginReplaceResult },
  source: PluginSource,
  entryPath: string,
  config: unknown,
  before: PluginManifestEntry[],
  staged?: { packageName: string; dir: string },
): Promise<InstalledPluginView> {
  const { name } = loaded
  await upsertManifest({
    name,
    ...(loaded.alias !== undefined ? { alias: loaded.alias } : {}),
    source, entryPath, config, installedAt: new Date().toISOString(),
  })
  loadErrors.delete(name)
  if (staged) await pruneStaged(staged.packageName, staged.dir)

  /* The overwritten install's leftovers. pruneStaged only knows about copies
     of the SAME package, and a replacement may well arrive under a different
     package name — installing `@me/funding-arb` over the `funding-arb` that
     declared the same plugin leaves the old package and its staged copy
     behind unless they are named here. */
  const previous = before.find(e => e.name === name)
  if (previous) await discard(previous, source, staged?.dir)

  const info = runtime.listLoadedPlugins().find(p => p.name === name)!
  return { ...info, source, ...(loaded.replace ? { replace: loaded.replace } : {}) }
}

/** Remove an install that has just been replaced by another. */
async function discard(previous: PluginManifestEntry, replacedBy: PluginSource, keepDir?: string): Promise<void> {
  const staleDir = stagedDirOf(previous.entryPath)
  if (staleDir && staleDir !== keepDir) await fs.promises.rm(staleDir, { recursive: true, force: true }).catch(() => {})
  if (previous.source.kind === 'file' && !staleDir) {
    await fs.promises.rm(previous.entryPath, { force: true }).catch(() => {})
  }
  const stale = packageNameOf(previous.source)
  if (stale === undefined || stale === packageNameOf(replacedBy)) return
  try {
    const npm = npmSpawn()
    await execFileAsync(npm.file, [...npm.args, 'uninstall', stale, '--prefix', getPluginsDir(), '--loglevel=error'], { timeout: 120_000 })
  } catch (err) {
    log().warn({ package: stale, err }, 'Could not remove the package this install replaced')
  }
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

/**
 * Resolve a package's ESM entry from its package.json (exports > module > main).
 *
 * The entry is checked for existence here rather than left to the loader,
 * because the interesting case declares one that was never built: a Git
 * install ships sources, and `dist/index.js` exists only if the package's
 * `prepare` script produced it. The loader's own report for that is
 * ERR_MODULE_NOT_FOUND on a path deep inside node_modules, which reads like
 * a broken engine rather than a package that needs a build step — so callers
 * pass the `hint` that explains their own failure mode.
 */
export function resolveEntry(pkgDir: string, hint?: string): string {
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
    /* Two shapes are legal. The subpath map keys on './…', and the sugar form
       drops the map entirely when a package exports only its root — so an
       object with no './' key IS the '.' entry, and reading it as a subpath
       map finds nothing and falls through to `main`, which such a package
       usually does not declare. (p-limit ships exactly this.) */
    const map = exp as Record<string, unknown>
    const isSubpathMap = Object.keys(map).some(k => k.startsWith('.'))
    const dot = isSubpathMap ? map['.'] : map
    if (typeof dot === 'string') entry = dot
    else if (dot && typeof dot === 'object') {
      const d = dot as Record<string, unknown>
      const picked = d['import'] ?? d['default']
      entry = typeof picked === 'object' && picked !== null
        ? (picked as Record<string, string>)['default']
        : (picked as string | undefined)
    }
  }
  entry = entry ?? pkg.module ?? pkg.main ?? 'index.js'
  const entryPath = path.join(pkgDir, entry)
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `The installed package declares its entry as "${entry}", but that file is not there.${hint ? ` ${hint}` : ''}`,
    )
  }
  return entryPath
}

/**
 * Install a plugin from npm into the managed plugins dir and load it.
 * ⚠️ Installing a package executes third-party code in this process.
 */
export async function installFromNpm(
  runtime: OpenWhaleRuntime,
  spec: string,
  config: unknown,
  overwrite = false,
  alias?: string,
): Promise<InstalledPluginView> {
  // Local package directory: npm symlinks it, so rebuilding the package and
  // restarting picks up changes — the dev loop for unpublished plugins.
  const localPath = asLocalPath(spec)
  const packageName = localPath ? localPackageName(localPath) : parsePackageSpec(spec).packageName
  const pluginsDir = getPluginsDir()
  await ensureStub()

  log().info({ spec, local: Boolean(localPath) }, 'Installing plugin')
  const npm = npmSpawn()
  await execFileAsync(npm.file, [...npm.args, 'install', localPath ?? spec, '--prefix', pluginsDir, '--no-audit', '--no-fund', '--loglevel=error'], {
    timeout: 300_000,
  })
  await shareEnginePackages()

  const source: PluginSource = localPath
    ? { kind: 'local', path: localPath, packageName }
    : { kind: 'npm', package: spec }
  return stageLoadAndRecord(runtime, packageName, source, config, overwrite, alias)
}

// ── GitHub install ────────────────────────────────────────────────────────────

/**
 * Everything a person plausibly has on their clipboard → `owner/repo` plus a
 * ref, plus the one spec form npm is unambiguous about.
 *
 * The forms matter because the address bar is where a repo actually comes
 * from. `https://github.com/o/r/tree/main/...` is what you get by browsing to
 * a plugin and hitting copy, and npm rejects it outright — asking the user to
 * hand-translate that into `github:o/r#main` is asking them to know npm's
 * spec grammar to paste a link.
 *
 * Output is always `git+https://…​.git`, never the `github:` shorthand, because
 * npm resolves the shorthand to ssh or https depending on the machine's git
 * config — and the token injection below only attaches to https. One spec
 * form means one auth path.
 */
export function parseGithubSpec(input: string, refOverride?: string): { repo: string; ref?: string; url: string } {
  let s = input.trim()
  if (!s) throw new Error('Give a repository, e.g. owner/repo or https://github.com/owner/repo')

  let ref: string | undefined
  const hash = s.indexOf('#')
  if (hash >= 0) {
    ref = s.slice(hash + 1).trim() || undefined
    s = s.slice(0, hash)
  }
  if (s.includes('?')) s = s.slice(0, s.indexOf('?'))

  s = s
    .replace(/^git\+/i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')

  if (/^[a-z+]+:\/\//i.test(s)) {
    throw new Error(`Only github.com repositories are supported here — "${input}" points somewhere else`)
  }

  const seg = s.split('/')
  const [owner, repoName, kind, ...rest] = seg
  if (seg.length > 2) {
    /* Browser URLs carry the ref in the path. A branch name may itself contain
       slashes (`feat/venue-proxy`), and a /tree/ URL gives no way to tell a
       slashed branch from a branch plus a directory — so the whole tail is
       read as the ref, which is right for the link people actually copy (the
       repo root on a branch) and wrong only for a deep-directory link. */
    if (/^(tree|blob|commit|commits)$/i.test(kind ?? '') && rest.length > 0) {
      ref = ref ?? rest.join('/')
    } else if (/^releases$/i.test(kind ?? '') && rest[0] === 'tag' && rest.length > 1) {
      ref = ref ?? rest.slice(1).join('/')
    } else {
      throw new Error(`"${input}" does not look like a repository — expected owner/repo, got ${seg.length} path segments`)
    }
  }

  if (refOverride?.trim()) ref = refOverride.trim()
  if (!owner || !repoName || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repoName)) {
    throw new Error(`"${input}" is not a valid GitHub repository — expected owner/repo`)
  }
  if (ref !== undefined && !/^[\w.\-/]+$/.test(ref)) {
    throw new Error(`"${ref}" is not a valid branch, tag or commit`)
  }

  const repo = `${owner}/${repoName}`
  return {
    repo,
    ...(ref !== undefined ? { ref } : {}),
    url: `git+https://github.com/${repo}.git${ref !== undefined ? `#${ref}` : ''}`,
  }
}

function githubToken(): string {
  return (process.env['OPENWHALE_GITHUB_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? '').trim()
}

/**
 * Environment for the npm child so its `git clone` can reach a private repo.
 *
 * The token goes in as an ephemeral git config (`GIT_CONFIG_*`, git ≥ 2.31)
 * rather than embedded in the clone URL, because a URL travels: npm writes
 * the spec it was given into this dir's package.json and lockfile, and the
 * manifest keeps it forever. A credential that reaches disk in a process that
 * also holds exchange keys is not a credential any more. As a config on the
 * child's environment it exists for the length of one install.
 *
 * GIT_TERMINAL_PROMPT is off regardless: without it, a private repo and no
 * token makes git block on a username prompt nobody can answer, and the
 * install "hangs" until the timeout instead of saying it needs auth.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const token = githubToken()
  const base = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (!token) return base
  return {
    ...base,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
}

/** Which of the stub's dependencies is the one npm just brought in. */
function installedName(before: Record<string, string>, after: Record<string, string>, repo: string): string {
  const added = Object.keys(after).filter(k => !(k in before))
  if (added.length === 1) return added[0]!
  // Re-installing an existing plugin adds no key — find it by what it points at
  const byUrl = Object.keys(after).find(k => (after[k] ?? '').toLowerCase().includes(repo.toLowerCase()))
  if (byUrl) return byUrl
  if (added.length > 1) throw new Error(`npm installed several packages and none names ${repo}: ${added.join(', ')}`)
  throw new Error(`npm installed nothing for ${repo}`)
}

const BUILD_HINT =
  'npm builds a Git install by running the package\'s "prepare" script — a repo that ships TypeScript sources ' +
  'and no build output needs one (e.g. "prepare": "npm run build"), or must commit its built files.'

/**
 * Install a plugin straight from a GitHub repository and load it.
 *
 * npm does the acquiring — it has cloned git specs for a decade, runs the
 * package's `prepare` script so a source-only repo still builds, and leaves
 * the result in the same node_modules the npm path uses, so uninstall and
 * boot-restore need no second code path.
 *
 * What it cannot do is tell us the package's name in advance: a repo called
 * `openwhale-funding-arb` may publish itself as `@someone/funding-arb`, and
 * the entry lives under the package name. So the stub's dependency map is
 * read before and after — npm's own record of what it did.
 *
 * ⚠️ Installing a package executes third-party code in this process.
 */
export async function installFromGithub(
  runtime: OpenWhaleRuntime,
  repoInput: string,
  refInput: string | undefined,
  config: unknown,
  overwrite = false,
  alias?: string,
): Promise<InstalledPluginView> {
  const { repo, ref, url } = parseGithubSpec(repoInput, refInput)
  const pluginsDir = getPluginsDir()
  await ensureStub()

  const before = await stubDeps()
  log().info({ repo, ref, authenticated: githubToken() !== '' }, 'Installing plugin from GitHub')
  const npm = npmSpawn()
  try {
    await execFileAsync(
      npm.file,
      [...npm.args, 'install', url, '--prefix', pluginsDir, '--no-audit', '--no-fund', '--loglevel=error'],
      // Longer than the npm path's: this one clones AND builds.
      { timeout: 600_000, env: gitEnv() },
    )
  } catch (err) {
    throw cloneError(err, repo)
  }
  await shareEnginePackages()

  const packageName = installedName(before, await stubDeps(), repo)
  const source: PluginSource = { kind: 'github', repo, ...(ref !== undefined ? { ref } : {}), packageName }
  return stageLoadAndRecord(runtime, packageName, source, config, overwrite, alias, BUILD_HINT)
}

/**
 * GitHub answers 404 for a private repo you are not authorised to see, so
 * git's "repository not found" is the same sentence for "wrong name" and
 * "needs a token". Saying so is the whole point of this function.
 */
function cloneError(err: unknown, repo: string): Error {
  const e = err as { stderr?: string; message?: string }
  const text = `${e.stderr ?? ''}\n${e.message ?? ''}`.trim()
  const denied = /not found|Authentication failed|could not read Username|Permission denied|access rights/i.test(text)
  if (denied && !githubToken()) {
    return new Error(
      `Could not read ${repo} from GitHub.\n\nIf the repository is private, that is what this looks like — ` +
        `GitHub returns "not found" rather than "not authorised" to anyone without access. Set ` +
        `OPENWHALE_GITHUB_TOKEN to a token with repo read access and restart the engine.\n\n${text}`,
    )
  }
  return new Error(text || `Installing ${repo} from GitHub failed`)
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
  overwrite = false,
  alias?: string,
): Promise<InstalledPluginView> {
  if (!/\.(mjs|js)$/i.test(originalName)) {
    throw new Error('Only built .js/.mjs bundles are supported for file install — for TypeScript sources or plugins with dependencies, publish to npm and install by package name')
  }
  const localDir = path.join(getPluginsDir(), 'local')
  await fs.promises.mkdir(localDir, { recursive: true })

  const base = path.basename(originalName).replace(/[^\w.-]/g, '_').replace(/\.(mjs|js)$/i, '')
  const entryPath = path.join(localDir, `${base}-${Date.now()}.mjs`)
  await fs.promises.writeFile(entryPath, content, 'utf8')

  const before = await readManifest()
  const source: PluginSource = { kind: 'file', originalName }
  let loaded: { name: string; alias?: string; replace?: PluginReplaceResult }
  try {
    loaded = await loadOrReplace(runtime, entryPath, config, { overwrite, alias, source, manifest: before })
  } catch (err) {
    await fs.promises.rm(entryPath, { force: true })
    throw err
  }
  // No staging: each upload already lands on a filename nothing has imported
  return record(runtime, loaded, source, entryPath, config, before)
}

// ── uninstall ─────────────────────────────────────────────────────────────────

/** 'a, b, c and 4 more' — enough to recognise, not a wall of ids. */
function nameList(ids: string[], show = 5): string {
  return ids.length <= show
    ? ids.join(', ')
    : `${ids.slice(0, show).join(', ')} and ${ids.length - show} more`
}

export async function uninstallPlugin(runtime: OpenWhaleRuntime, name: string): Promise<void> {
  // A plugin that failed to load on boot has nothing registered — skip unload.
  const isLoaded = runtime.listLoadedPlugins().some(p => p.name === name)
  if (isLoaded) {
    const deps = await runtime.pluginDependents(name)
    /* Instances, accounts and credentials are the user's, not the plugin's:
       params they tuned, a key they pasted, an equity history. Uninstall
       removes code, and must not quietly take those with it — so it stops and
       names them. Deleting them is a decision, and it stays the user's. */
    const blockers = [
      deps.instances.length > 0 ? `${deps.instances.length} strategy instance(s) — ${nameList(deps.instances)}` : '',
      deps.accounts.length > 0 ? `${deps.accounts.length} account(s) — ${nameList(deps.accounts)}` : '',
      deps.credentials.length > 0 ? `${deps.credentials.length} credential(s) — ${nameList(deps.credentials)}` : '',
    ].filter(Boolean)
    if (blockers.length > 0) {
      throw new Error(
        `Cannot uninstall "${name}" — it is still in use by ${blockers.join('; ')}. ` +
          'Delete those first: each one holds something you configured, and uninstalling would leave it pointing at code that no longer exists.',
      )
    }
    /* Monitor instances go with the plugin. They are its own plumbing —
       mostly auto-created for a contract — and carry nothing a person chose,
       so leaving them behind would only produce broken rows nobody asked for. */
    for (const id of deps.monitorInstances) {
      await runtime.deleteMonitorInstance(id)
    }
    if (deps.monitorInstances.length > 0) {
      log().info({ plugin: name, instances: deps.monitorInstances }, 'Deleted the plugin\'s monitor instances')
    }
    await runtime.unloadPlugin(name)
  }

  const entries = await readManifest()
  const entry = entries.find(e => e.name === name)
  await writeManifest(entries.filter(e => e.name !== name))
  loadErrors.delete(name)
  if (!entry) return

  if (entry.source.kind !== 'file') {
    // npm derives the package name from its spec; the other two carry it,
    // because neither a directory nor a repo is named after what it publishes.
    const packageName = entry.source.kind === 'npm'
      ? parsePackageSpec(entry.source.package).packageName
      : entry.source.packageName
    try {
      const npm = npmSpawn()
      await execFileAsync(npm.file, [...npm.args, 'uninstall', packageName, '--prefix', getPluginsDir(), '--loglevel=error'], { timeout: 120_000 })
    } catch (err) {
      log().warn({ name, err }, 'npm uninstall failed — manifest entry removed anyway')
    }
    /* The staged copy too, or reinstalling would prune it as an old
       generation anyway and the disk would hold a plugin nobody installed.
       stagedDirOf refuses any path outside the staging root — entries written
       before staging existed point straight into node_modules, and this must
       never be handed one of those. */
    const staged = stagedDirOf(entry.entryPath)
    if (staged) await fs.promises.rm(staged, { recursive: true, force: true })
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
      await runtime.loadPluginFromPath(entry.entryPath, entry.config, entry.alias !== undefined ? { as: entry.alias } : undefined)
      loadErrors.delete(entry.name)
      log().info({ plugin: entry.name }, 'Restored plugin')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loadErrors.set(entry.name, message)
      log().error({ plugin: entry.name, err }, 'Failed to restore plugin — skipping')
    }
  }
}

// ── updates ──────────────────────────────────────────────────────────────────

export interface PluginUpdate {
  name: string
  packageName: string
  installed: string
  latest: string
}

/**
 * npm-installed plugins whose registry "latest" is newer than what is
 * installed. One `npm view` per plugin, in parallel; a registry that does
 * not answer for one package just leaves that package out.
 */
export async function checkPluginUpdates(): Promise<PluginUpdate[]> {
  const manifest = await readManifest()
  const pluginsDir = getPluginsDir()
  const npm = npmSpawn()
  const checks = manifest
    .filter(e => e.source.kind === 'npm')
    .map(async (e): Promise<PluginUpdate | undefined> => {
      const packageName = packageNameOf(e.source)
      if (!packageName) return undefined
      let installed: string
      try {
        installed = (JSON.parse(await fs.promises.readFile(path.join(pluginsDir, 'node_modules', packageName, 'package.json'), 'utf8')) as { version: string }).version
      } catch { return undefined }
      try {
        const { stdout } = await execFileAsync(npm.file, [...npm.args, 'view', packageName, 'version', '--loglevel=error'], { timeout: 20_000 })
        const latest = stdout.trim()
        return latest && latest !== installed ? { name: e.name, packageName, installed, latest } : undefined
      } catch { return undefined }
    })
  return (await Promise.all(checks)).filter((u): u is PluginUpdate => u !== undefined)
}

/**
 * Manifest entries that are installed but not loaded get staged and loaded
 * again. Overwriting a plugin unloads everything that depends on it (a
 * strategy package on its venue package), and without this the dependents
 * stayed dark until someone reinstalled them by hand.
 */
export async function reloadUnloaded(runtime: OpenWhaleRuntime): Promise<string[]> {
  const reloaded: string[] = []
  for (const entry of await readManifest()) {
    if (runtime.listLoadedPlugins().some(p => p.name === entry.name)) continue
    const packageName = packageNameOf(entry.source)
    if (!packageName) continue
    try {
      await stageLoadAndRecord(runtime, packageName, entry.source, entry.config, true, entry.alias)
      loadErrors.delete(entry.name)
      reloaded.push(entry.name)
      log().info({ plugin: entry.name }, 'Reloaded plugin after an overwrite unloaded it')
    } catch (err) {
      loadErrors.set(entry.name, err instanceof Error ? err.message : String(err))
      log().error({ plugin: entry.name, err }, 'Failed to reload plugin')
    }
  }
  return reloaded
}

/**
 * Bring an npm-installed plugin to a version (default: the registry's
 * latest), reload whatever the overwrite unloaded, and re-activate the
 * instances that were running before — an update should be invisible to
 * a strategy that was busy.
 */
export async function updatePlugin(runtime: OpenWhaleRuntime, name: string, version?: string): Promise<{ plugin: InstalledPluginView; reloaded: string[]; reactivated: string[] }> {
  const entry = (await readManifest()).find(e => e.name === name)
  if (!entry) throw new Error(`Plugin "${name}" is not installed`)
  if (entry.source.kind !== 'npm') throw new Error(`Plugin "${name}" was not installed from the npm registry — reinstall it from its source instead`)
  const packageName = parsePackageSpec(entry.source.package).packageName
  const wasActive = (await runtime.listInstanceViews()).filter(i => i.active).map(i => i.id)
  const plugin = await installFromNpm(runtime, `${packageName}@${version ?? 'latest'}`, entry.config, true, entry.alias)
  const reloaded = await reloadUnloaded(runtime)
  const reactivated: string[] = []
  for (const view of await runtime.listInstanceViews()) {
    if (!wasActive.includes(view.id) || view.active) continue
    try { await runtime.activateById(view.id); reactivated.push(view.id) } catch (err) { log().warn({ instance: view.id, err }, 'Instance did not come back after the update') }
  }
  return { plugin, reloaded, reactivated }
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
