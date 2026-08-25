import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { pathToFileURL } from 'url'
import { asLocalPath, npmSpawn, parseGithubSpec, resolveEntry, stage, stagedDirOf, pruneStaged } from '../plugins.js'

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
