import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { pathToFileURL, fileURLToPath } from 'url'
import { asLocalPath, npmSpawn, parseGithubSpec, resolveEntry, stage, stagedDirOf, pruneStaged, suggestAlias, shareEnginePackages, unmetFrameworkNeeds } from '../plugins.js'

const isWin = process.platform === 'win32'

describe('asLocalPath', () => {
  it('recognizes the absolute-path forms of every platform', () => {
    // path.win32 / path.posix are pure string parsers, so a spec classifies
    // identically on any host — these assertions are not Windows-only.
    expect(asLocalPath('/usr/lib/openwhale/plugins/early-trend')).toBe('/usr/lib/openwhale/plugins/early-trend')
    expect(asLocalPath('D:\\Dev\\pkg')).toBe('D:\\Dev\\pkg')
    expect(asLocalPath('D:/Dev/pkg')).toBe('D:/Dev/pkg')
    expect(asLocalPath('\\\\srv\\share\\pkg')).toBe('\\\\srv\\share\\pkg')
    expect(asLocalPath('//srv/share/pkg')).toBe('//srv/share/pkg')
  })

  it('expands a leading ~ against the home directory', () => {
    expect(asLocalPath('~/pkg')).toBe(path.join(os.homedir(), 'pkg'))
  })

  it('keeps the historical file: prefix stripping', () => {
    expect(asLocalPath('file:/abs/pkg')).toBe('/abs/pkg')
    expect(asLocalPath('file:~/pkg')).toBe(path.join(os.homedir(), 'pkg'))
  })

  it('rejects npm specs and ambiguous paths', () => {
    for (const spec of [
      'lodash',                        // plain package
      '@scope/pkg@1.2.0',              // scoped + range
      'x@npm:pkg',                     // alias
      'github:user/repo',              // git shorthand — must not read as a drive
      'git+ssh://git@host/repo.git',   // git URL
      './pkg', '../pkg',               // relative
      'D:pkg', 'D:',                   // drive-relative (ambiguous — per-drive CWD)
    ]) {
      expect(asLocalPath(spec), `spec: ${spec}`).toBeUndefined()
    }
  })
})

describe('npmSpawn', () => {
  it('uses the plain npm command off Windows', () => {
    if (isWin) return
    expect(npmSpawn()).toEqual({ file: 'npm', args: [] })
  })

  it('invokes npm-cli.js with the running Node binary on Windows', () => {
    if (!isWin) return
    const npm = npmSpawn()
    expect(npm.file).toBe(process.execPath)
    expect(npm.args).toHaveLength(1)
    expect(npm.args[0]).toMatch(/[\\/]npm-cli\.js$/)
  })
})

describe('parseGithubSpec', () => {
  const url = (repo: string, ref?: string) => `git+https://github.com/${repo}.git${ref ? `#${ref}` : ''}`

  it('accepts every shorthand and URL a repo is copied as', () => {
    for (const input of [
      'OpenWhale-Org/OpenWhale',
      'github:OpenWhale-Org/OpenWhale',
      'https://github.com/OpenWhale-Org/OpenWhale',
      'http://www.github.com/OpenWhale-Org/OpenWhale',
      'https://github.com/OpenWhale-Org/OpenWhale.git',
      'git+https://github.com/OpenWhale-Org/OpenWhale.git',
      'git@github.com:OpenWhale-Org/OpenWhale.git',
      'ssh://git@github.com/OpenWhale-Org/OpenWhale.git',
      '  https://github.com/OpenWhale-Org/OpenWhale/  ',
    ]) {
      expect(parseGithubSpec(input), `input: ${input}`).toEqual({
        repo: 'OpenWhale-Org/OpenWhale',
        url: url('OpenWhale-Org/OpenWhale'),
      })
    }
  })

  /* The whole reason this parser exists: what the address bar gives you is a
     /tree/ URL, and npm rejects it. */
  it('reads the ref out of a browsed URL', () => {
    expect(parseGithubSpec('https://github.com/o/r/tree/main')).toEqual({ repo: 'o/r', ref: 'main', url: url('o/r', 'main') })
    expect(parseGithubSpec('https://github.com/o/r/commit/4f3a91c').ref).toBe('4f3a91c')
    expect(parseGithubSpec('https://github.com/o/r/releases/tag/v1.2.0').ref).toBe('v1.2.0')
  })

  it('keeps a slashed branch name whole', () => {
    // A branch may contain slashes, so the tail of a /tree/ URL is the ref —
    // `feat/venue-proxy`, not `feat`.
    expect(parseGithubSpec('https://github.com/o/r/tree/feat/venue-proxy').ref).toBe('feat/venue-proxy')
  })

  it('takes the ref from a # suffix', () => {
    expect(parseGithubSpec('o/r#v2').ref).toBe('v2')
    expect(parseGithubSpec('git+https://github.com/o/r.git#abc123').ref).toBe('abc123')
  })

  it('lets an explicit ref beat one carried by the URL', () => {
    // The form's ref box exists so a pasted link can be retargeted without editing it
    expect(parseGithubSpec('https://github.com/o/r/tree/main', 'v1.0.0').ref).toBe('v1.0.0')
    expect(parseGithubSpec('o/r#main', ' dev ').ref).toBe('dev')
    expect(parseGithubSpec('o/r#main', '  ').ref).toBe('main')   // blank box = no opinion
  })

  it('drops query strings', () => {
    expect(parseGithubSpec('https://github.com/o/r?tab=readme-ov-file').repo).toBe('o/r')
  })

  it('rejects what is not a github repo', () => {
    for (const input of [
      '',
      'lodash',                                   // npm package, wrong tab
      'https://gitlab.com/o/r',                   // another host
      'https://github.com/o/r/issues/34',         // a page, not a ref
      'https://github.com/OpenWhale-Org',         // owner only
      'o/r#bad ref',                              // space in ref
      'o/r#--upload-pack=x',                      // argument-shaped ref
    ]) {
      expect(() => parseGithubSpec(input), `input: ${input}`).toThrow()
    }
  })
})

describe('resolveEntry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-entry-'))
  /** A package dir with the given package.json and the listed files present. */
  const pkg = (name: string, manifest: unknown, files: string[]) => {
    const dir = path.join(root, name)
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
    for (const f of files) fs.writeFileSync(path.join(dir, f), '')
    return dir
  }

  it('reads the subpath map, preferring import over default', () => {
    const dir = pkg('subpath', { exports: { '.': { import: './dist/esm.js', default: './dist/cjs.js' } } }, ['dist/esm.js', 'dist/cjs.js'])
    expect(resolveEntry(dir)).toBe(path.join(dir, 'dist/esm.js'))
  })

  /* The sugar form has no './' key, so reading it as a subpath map finds
     nothing and silently falls through to `main` — which a package shaped
     this way usually does not declare. p-limit ships exactly this. */
  it('treats a conditions-only exports object as the root entry', () => {
    const dir = pkg('sugar', { exports: { types: './index.d.ts', default: './dist/real.js' }, main: './wrong.js' }, ['dist/real.js', 'wrong.js'])
    expect(resolveEntry(dir)).toBe(path.join(dir, 'dist/real.js'))
  })

  it('falls back to module then main then index.js', () => {
    const a = pkg('mod', { module: './dist/m.js', main: './dist/c.js' }, ['dist/m.js', 'dist/c.js'])
    expect(resolveEntry(a)).toBe(path.join(a, 'dist/m.js'))
    const b = pkg('bare', {}, ['index.js'])
    expect(resolveEntry(b)).toBe(path.join(b, 'index.js'))
  })

  /* The GitHub case this exists for: the repo declares dist/index.js and
     shipped only sources, because nothing built it. */
  it('names the missing entry instead of leaving it to the loader', () => {
    const dir = pkg('unbuilt', { exports: './dist/index.js' }, [])
    expect(() => resolveEntry(dir, 'needs a prepare script')).toThrow(/dist\/index\.js.*not there.*needs a prepare script/s)
  })
})

describe('staging — what makes a reinstall load new code', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-stage-'))
  const pkgDir = path.join(data, 'plugins', 'node_modules', 'demo-plugin')
  const prevDb = process.env['OPENWHALE_DB_PATH']

  beforeAll(() => { process.env['OPENWHALE_DB_PATH'] = path.join(data, 'openwhale.db') })
  afterAll(() => {
    if (prevDb === undefined) delete process.env['OPENWHALE_DB_PATH']
    else process.env['OPENWHALE_DB_PATH'] = prevDb
  })

  /** Write the "installed" package as npm would have left it. */
  const install = (version: string) => {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(pkgDir, 'node_modules', 'some-dep'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', exports: './dist/index.js' }))
    // The entry re-exports a sibling — the case a cache-busting query cannot reach
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), "export { V } from './helper.js'\n")
    fs.writeFileSync(path.join(pkgDir, 'dist', 'helper.js'), `export const V = '${version}'\n`)
    fs.writeFileSync(path.join(pkgDir, 'node_modules', 'some-dep', 'index.js'), '')
  }

  it('copies the package out of node_modules, linking back to its own node_modules', async () => {
    install('v1')
    const { entryPath, dir } = await stage('demo-plugin')
    expect(stagedDirOf(entryPath)).toBe(dir)
    expect(fs.existsSync(entryPath)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'dist', 'helper.js'))).toBe(true)
    // Not copied (pnpm's relative symlinks would break) but reachable: a
    // local package's own deps resolve through a link to the original dir
    const nm = path.join(dir, 'node_modules')
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(nm, 'some-dep', 'index.js'))).toBe(true)
  })

  /* The whole point. Node's ESM registry is keyed by resolved URL and cannot
     be evicted, so a stable path means the first version loaded is the one
     that runs forever — including siblings, which a ?query on the entry does
     not refresh. */
  it('a reinstall executes the new code, siblings included', async () => {
    install('v1')
    const first = await stage('demo-plugin')
    const a = await import(pathToFileURL(first.entryPath).href)
    expect(a.V).toBe('v1')

    install('v2')                                    // uninstall + install again
    const second = await stage('demo-plugin')
    expect(second.dir).not.toBe(first.dir)
    const b = await import(pathToFileURL(second.entryPath).href)
    expect(b.V).toBe('v2')

    // …and for contrast, the old path still serves the old module forever
    expect((await import(pathToFileURL(first.entryPath).href)).V).toBe('v1')
  })

  /* A package directory can pick up links from tools other than npm — a
     deploy script's, in the case this comes from. The copy dereferences, so
     one that dangles used to abort the whole install with an ENOENT naming a
     path the user never typed. */
  it('copies past a dangling symlink instead of dying on it', async () => {
    install('v1')
    fs.symlinkSync('../../../nowhere/at/all', path.join(pkgDir, 'stray-link'))
    const { entryPath, dir } = await stage('demo-plugin')
    expect(fs.existsSync(entryPath)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'stray-link'))).toBe(false)
    fs.rmSync(path.join(pkgDir, 'stray-link'), { force: true })
  })

  it('prunes earlier generations but keeps the live one', async () => {
    install('v1')
    const older = await stage('demo-plugin')
    const live = await stage('demo-plugin')
    await pruneStaged('demo-plugin', live.dir)
    expect(fs.existsSync(older.dir)).toBe(false)
    expect(fs.existsSync(live.dir)).toBe(true)
  })

  /* stagedDirOf's answer is handed to rm -rf, so anything not inside the
     staging root must come back undefined — manifest entries written before
     staging existed point straight into node_modules. */
  it('refuses to claim a path outside the staging root', () => {
    for (const p of [
      path.join(data, 'plugins', 'node_modules', 'demo-plugin', 'dist', 'index.js'),
      path.join(data, 'plugins', 'local', 'bundle-123.mjs'),
      path.join(data, 'plugins', 'staged'),
      '/etc/passwd',
    ]) {
      expect(stagedDirOf(p), `path: ${p}`).toBeUndefined()
    }
  })
})

describe('suggestAlias — a namespace for somebody else\'s plugin of the same name', () => {
  /* The suggestion is not a throwaway: from here on it is the first half of
     every id the plugin registers, and instances persist those ids. Naming the
     publisher is what makes two `funding-arb`s tellable apart in a rail. */
  it('names the publisher when the source has one', () => {
    expect(suggestAlias('funding-arb', { kind: 'github', repo: 'alice/funding-arb', packageName: 'funding-arb' }, ['funding-arb']))
      .toBe('alice-funding-arb')
    expect(suggestAlias('funding-arb', { kind: 'npm', package: '@alice/funding-arb' }, ['funding-arb']))
      .toBe('alice-funding-arb')
  })

  it('falls back to numbering when there is no publisher to name', () => {
    // An unscoped npm package and an uploaded bundle say nothing about whose it is
    expect(suggestAlias('funding-arb', { kind: 'npm', package: 'funding-arb' }, ['funding-arb'])).toBe('funding-arb-2')
    expect(suggestAlias('funding-arb', { kind: 'file', originalName: 'bundle.mjs' }, ['funding-arb'])).toBe('funding-arb-2')
  })

  it('keeps going until it finds one nothing is using', () => {
    const taken = ['funding-arb', 'alice-funding-arb', 'funding-arb-2', 'funding-arb-3']
    expect(suggestAlias('funding-arb', { kind: 'github', repo: 'alice/funding-arb', packageName: 'x' }, taken))
      .toBe('funding-arb-4')
  })

  it('produces something usable as one id segment', () => {
    // Whatever the source looked like, the result has to survive being half of
    // `<namespace>/<strategy>` — the runtime rejects anything else
    const alias = suggestAlias('funding arb!', { kind: 'github', repo: 'Al.ice_9/x', packageName: 'x' }, [])
    expect(alias).toMatch(/^[A-Za-z0-9][\w.-]*$/)
  })
})

describe('shareEnginePackages — one copy of the framework, not two', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-share-'))
  const scope = path.join(data, 'plugins', 'node_modules', '@openwhaleorg')
  const prevDb = process.env['OPENWHALE_DB_PATH']

  beforeAll(() => { process.env['OPENWHALE_DB_PATH'] = path.join(data, 'openwhale.db') })
  afterAll(() => {
    if (prevDb === undefined) delete process.env['OPENWHALE_DB_PATH']
    else process.env['OPENWHALE_DB_PATH'] = prevDb
  })

  const engineCoreVersion = JSON.parse(
    fs.readFileSync(new URL('../../../../framework/core/package.json', import.meta.url), 'utf8'),
  ).version as string

  /** A package directory as npm would have left it. */
  const fetched = (name: string, version: string) => {
    const dir = path.join(scope, name)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@openwhaleorg/${name}`, version }))
    fs.writeFileSync(path.join(dir, 'index.js'), '')
    return dir
  }

  /* The peer declaration exists so a plugin shares the engine's core; npm
     satisfies a missing peer by downloading one, producing the second copy the
     declaration was meant to prevent. Two copies are two module registries. */
  it('replaces a fetched framework package with a link to the engine\'s copy', async () => {
    const dir = fetched('core', engineCoreVersion)
    await shareEnginePackages()

    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true)
    // Resolving through it must land on the very file the engine runs
    expect(fs.realpathSync(path.join(dir, 'package.json')))
      .toBe(fs.realpathSync(fileURLToPath(new URL('../../../../framework/core/package.json', import.meta.url))))
  })

  /* Not even for a version the engine cannot be: one copy of the framework is
     not a preference to weigh here. Whether the plugin can work against the
     engine's version has an answer — its declared range — and refusing on it
     belongs at install, where it can say which package and which way to move
     (unmetFrameworkNeeds). Leaving a second copy behind instead would hand the
     plugin a module registry the engine never reads. */
  it('links a version the engine could never satisfy, and leaves the refusing to install', async () => {
    const dir = fetched('core', '9.9.9')
    await shareEnginePackages()
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(path.join(dir, 'package.json')))
      .toBe(fs.realpathSync(fileURLToPath(new URL('../../../../framework/core/package.json', import.meta.url))))
  })

  it('names the mismatch at install time, with the range and the engine version', () => {
    const dir = path.join(scope, '..', 'incompatible-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'incompatible-plugin',
      peerDependencies: { '@openwhaleorg/core': '^9.0.0' },
    }))
    expect(unmetFrameworkNeeds(dir)).toEqual([
      { package: '@openwhaleorg/core', range: '^9.0.0', engine: engineCoreVersion },
    ])
  })

  it('says nothing about a workspace range — that is a checkout, not a claim about releases', () => {
    const dir = path.join(scope, '..', 'workspace-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-plugin',
      peerDependencies: { '@openwhaleorg/core': 'workspace:^' },
    }))
    expect(unmetFrameworkNeeds(dir)).toEqual([])
  })

  /* npm picks the newest version satisfying the plugin's range, often a patch
     ahead of the engine. Demanding equality would leave that copy in place —
     the exact thing this is preventing. */
  it('links across a patch difference', async () => {
    const [major, minor] = engineCoreVersion.split('.')
    const dir = fetched('core', `${major}.${minor}.99`)
    await shareEnginePackages()
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true)
  })

  it('does not touch a package the engine does not provide', async () => {
    const dir = fetched('some-plugin', '1.0.0')
    await shareEnginePackages()
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(false)
  })

  it('is a no-op when nothing was fetched', async () => {
    fs.rmSync(scope, { recursive: true, force: true })
    await expect(shareEnginePackages()).resolves.toBeUndefined()
  })
})
