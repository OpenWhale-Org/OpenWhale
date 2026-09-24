import { describe, it, expect } from 'vitest'
import { page } from '../reportHtml.js'

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
