import { describe, it, expect, afterEach } from 'vitest'
import { prettyWanted } from '../logger.js'

/**
 * 生产环境不能跑美化日志。
 *
 * 这个判断曾经只看 NODE_ENV，而服务器上没人设 NODE_ENV —— 于是生产一直在打
 * 彩色多行：一条「什么都没发生」的记录从 ~120 字节涨到 ~550，8.6 GB/天，最终
 * 把 242G 的盘写满（2026-10-01）。所以现在钉的是「没有 TTY 就不美化」。
 */
describe('prettyWanted', () => {
  const env = process.env['NODE_ENV']
  const tty = process.stdout.isTTY
  const setTty = (v: unknown) => Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true })
  afterEach(() => {
    if (env === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = env
    Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true })
  })

  it('systemd 下没有 TTY，NODE_ENV 也没设——不美化', () => {
    delete process.env['NODE_ENV']
    setTty(undefined)
    expect(prettyWanted()).toBe(false)
  })

  it('终端里开着，才美化', () => {
    delete process.env['NODE_ENV']
    setTty(true)
    expect(prettyWanted()).toBe(true)
  })

  it('NODE_ENV=production 一票否决，哪怕在终端里', () => {
    process.env['NODE_ENV'] = 'production'
    setTty(true)
    expect(prettyWanted()).toBe(false)
  })

  it('管道输出也不美化——ANSI 转义进了日志文件就是垃圾', () => {
    delete process.env['NODE_ENV']
    setTty(false)
    expect(prettyWanted()).toBe(false)
  })
})
