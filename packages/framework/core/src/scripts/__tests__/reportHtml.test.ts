import { describe, it, expect } from 'vitest'
import { page, stamp } from '../reportHtml.js'

describe('reportPage 的说明文字开关', () => {
  const html = page({
    title: 't', eyebrow: 'pair-arb / engine-audit', h1: 'x',
    lede: 'a lede that folds away',
    ident: ['key'],
    body: `<p class="dim">a wall of prose</p>`
      + `<table><tr><td class="dim">a data cell</td></tr></table>`
      + `<p class="dim chart-hint">scroll to zoom</p>`
      + `<p class="warn">* still open</p>`,
    footer: 'more prose',
  })

  it('默认折起来，而且不会闪一下', () => {
    // terse 写在标记里，不是脚本跑完才加的
    expect(html).toContain('<body class="terse">')
  })

  it('开关在 header 里', () => {
    expect(html).toContain('<label class="prose"><input type="checkbox" id="prose"><span>Notes</span></label>')
    expect(html).toContain('ow-report-prose')
  })

  it('只折段落，不折数据', () => {
    expect(html).toContain('body.terse p.lede,body.terse p.dim,body.terse p.note,body.terse footer{display:none}')
    // dim 也是单元格和 span 的类名，那些是数据
    expect(html).not.toContain('body.terse .dim')
    expect(html).toContain('<td class="dim">a data cell</td>')
  })

  it('警告不折——它要人去看', () => {
    expect(html).toContain('<p class="warn">* still open</p>')
  })
})

describe('stamp', () => {
  it('把日期写进标记，脚本没跑也能读', () => {
    // 报告常常是半年后从 file:// 打开的，那时候脚本未必还能跑
    expect(stamp(Date.UTC(2026, 8, 28, 14, 52, 22, 854)))
      .toBe('<time data-ts="1790607142854">09-28 14:52:22.854</time>')
  })

  it('没有时间就是没有，不编一个 1970', () => {
    expect(stamp(undefined)).toBe('—')
    expect(stamp(NaN)).toBe('—')
  })
})

describe('时区开关', () => {
  const html = page({
    title: 't', eyebrow: 'e', h1: 'x', ident: [],
    body: `<table><tr><td>${stamp(Date.UTC(2026, 8, 28, 14, 52, 22, 854))}</td></tr></table>`,
    footer: '',
  })

  it('开关跟 Notes 挨着', () => {
    expect(html).toContain('<label class="prose tz"><input type="checkbox" id="tz"><span>Local time</span></label>')
    expect(html).toContain('ow-report-tz')
  })

  it('标记里写的是 UTC——报告发给别人，不能在他那里变成另一个钟点', () => {
    expect(html).toContain('>09-28 14:52:22.854</time>')
  })

  /**
   * 脚本真的跑一遍。核心包没有 DOM，所以搭一个刚好够用的：开关脚本只碰
   * getElementById / querySelector(All) / textContent / addEventListener，
   * 这几样手写比拉一个 jsdom 便宜。
   */
  const run = (localPref: string | null) => {
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
    const node = { attr: '1790607142854', textContent: '09-28 14:52:22.854', getAttribute: () => node.attr }
    let onChange = (): void => {}
    const box = {
      checked: false,
      closest: () => ({ style: {} }),
      addEventListener: (_: string, f: () => void) => { onChange = f },
    }
    const store: Record<string, string> = {}
    if (localPref !== null) store['ow-report-tz'] = localPref
    const win: Record<string, unknown> = {}
    const doc = {
      documentElement: { setAttribute: () => {} },
      getElementById: (id: string) => (id === 'tz' ? box : null),
      // 选择器要认——同一个 script 块里还有 Notes 和图例的脚本，它们找的是别的东西
      querySelector: (sel: string) => (sel === '[data-ts]' ? node : null),
      querySelectorAll: (sel: string) => (sel === '[data-ts]' ? [node] : []),
    }
    const fn = new Function('document', 'window', 'localStorage', 'CustomEvent', script)
    fn(doc, { ...win, addEventListener: () => {}, dispatchEvent: () => {}, get owTz() { return win.owTz }, set owTz(v) { win.owTz = v } },
      { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } },
      class { constructor(public type: string) {} })
    return { node, box, store, flip: () => { box.checked = !box.checked; onChange() } }
  }

  it('默认 UTC', () => {
    expect(run(null).node.textContent).toBe('09-28 14:52:22.854')
  })

  it('切到本地时区，改的是同一个节点，毫秒不丢', () => {
    const r = run(null)
    r.flip()
    const d = new Date(1790607142854)
    const p = (n: number) => String(n).padStart(2, '0')
    expect(r.node.textContent)
      .toBe(`${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.854`)
    expect(r.store['ow-report-tz']).toBe('local')
  })

  it('记住上次的选择', () => {
    const r = run('local')
    expect(r.box.checked).toBe(true)
    expect(r.node.textContent).not.toBe('09-28 14:52:22.854')
  })
})
