import { describe, it, expect } from 'vitest'
import path from 'path'
import os from 'os'
import { asLocalPath, npmSpawn } from '../plugins.js'

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
