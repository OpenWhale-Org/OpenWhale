#!/usr/bin/env node
/**
 * 发布前把每个包真的打一遍,检查 tarball 里的 peer 范围。
 *
 *   node scripts/check-publish.mjs                 # 检查全部可发布的包
 *   node scripts/check-publish.mjs web3 exchange   # 只查这几个
 *
 * 为什么必须在这里查:peer 里写的 `workspace:^` 不是一个 semver 范围,是一条
 * 指令 —— "打包时去工作区查一下那个包的版本,写成 ^<版本>"。真正上传的数字
 * 是 pnpm 在 pack 那一刻算出来的,**在仓库里任何地方都不存在**,读源码和读
 * diff 都看不见它,直到它已经发到 npm 上、不可变了才第一次露面。
 *
 * 2026-08-25 就是这么坏的:exchange@0.1.0 和 web3@0.1.0 发出去的 peer 是
 * 精确的 "@openwhaleorg/core": "0.1.1"(`workspace:*` 的产物,而且 core 那时
 * 还是 0.1.1),于是任何要求 core ^0.2.0 的插件都和它们互斥,从 npm 装一律
 * ERESOLVE。源码那时已经是对的,坏的只有那一刻的打包状态。
 *
 * 所以这里不读 package.json,只读打出来的 tarball —— 检查的必须是要发出去的
 * 那个字节,不是它应该长成的样子。
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 工作区里每个包当前的版本,peer 范围必须指向它们。 */
function workspaceVersions() {
  const out = new Map()
  const listing = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { cwd: repo, encoding: 'utf8' }))
  for (const p of listing) if (p.name) out.set(p.name, { version: p.version, dir: p.path, private: p.private === true })
  return out
}

function packedManifest(dir) {
  const dest = mkdtempSync(path.join(tmpdir(), 'ow-check-'))
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', dest], { cwd: dir, stdio: 'pipe' })
    const tgz = readdirSync(dest).find(f => f.endsWith('.tgz'))
    if (!tgz) throw new Error('pnpm pack 没有产出 tarball')
    execFileSync('tar', ['-xzf', path.join(dest, tgz), '-C', dest])
    return JSON.parse(readFileSync(path.join(dest, 'package', 'package.json'), 'utf8'))
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

const only = process.argv.slice(2)
const versions = workspaceVersions()
const targets = [...versions.entries()]
  .filter(([name, p]) => !p.private && (only.length === 0 || only.some(a => name === a || name.endsWith(`/${a}`))))

if (targets.length === 0) {
  console.error(only.length ? `没有匹配的包: ${only.join(', ')}` : '没有可发布的包')
  process.exit(1)
}

let failed = 0
for (const [name, pkg] of targets) {
  const manifest = packedManifest(pkg.dir)
  const problems = []

  if (manifest.version !== pkg.version) {
    problems.push(`tarball 版本是 ${manifest.version},工作区是 ${pkg.version}`)
  }
  for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const target = versions.get(dep)
    if (!target) continue   // 外部包(zod 之类),范围由作者自己写
    if (!range.startsWith('^')) {
      problems.push(`peer ${dep} 是 "${range}" —— 不是 caret,会把它锁死`)
    } else if (range !== `^${target.version}`) {
      problems.push(`peer ${dep} 是 "${range}",工作区里它是 ${target.version}`)
    }
    if (range.startsWith('workspace:')) {
      problems.push(`peer ${dep} 还留着 "${range}" —— workspace 协议没有被展开,npm 装不了`)
    }
  }

  const peers = Object.entries(manifest.peerDependencies ?? {}).map(([k, v]) => `${k}@${v}`).join(', ') || '无 peer'
  if (problems.length === 0) {
    console.log(`  ✓ ${name}@${manifest.version}  ${peers}`)
  } else {
    failed++
    console.log(`  ✗ ${name}@${manifest.version}`)
    for (const p of problems) console.log(`      ${p}`)
  }
}

if (failed > 0) {
  console.log(`\n${failed} 个包不能发布。`)
  process.exit(1)
}
console.log(`\n${targets.length} 个包检查通过,可以发布。`)
