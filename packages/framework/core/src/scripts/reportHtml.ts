/**
 * The house shell for HTML reports — the page every script that exports one
 * shares.
 *
 * Shared not to save code but so the reports look like one product: the same
 * palette, the same tables, the same footer stating where the numbers came
 * from. Two reports each carrying their own CSS drift into two products
 * within a year.
 *
 * Self-contained on purpose. No external CSS, fonts or scripts, and the only
 * JS is the legend toggle below. These files get downloaded, mailed around,
 * and opened again in six months from a `file://` URL — every external
 * dependency is a reason one of them will not render then. Which is also why
 * the charset is declared in the document: opened from disk there are no HTTP
 * headers, and a missing charset turns the whole report into mojibake.
 *
 * Themed in three states: unmarked (follows the OS), `data-theme="light"`,
 * and `data-theme="dark"`.
 */

export const esc = (s: unknown): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export const num = (v: number, d = 0): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export const signed = (v: number, d = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`

/** Positive = good, negative = bad. Zero stays neutral: a report that is
    green everywhere has no colour at all. */
export const cls = (v: number): string => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim')

/**
 * A timestamp the reader can re-zone.
 *
 * Rendered UTC into the markup so the file is correct with JavaScript off or
 * broken — which is the state these reports are usually read in six months
 * later, from a file:// URL. The epoch milliseconds ride along in `data-ts`
 * and the switch in the header rewrites every one of them in place.
 *
 * The date is not optional: an audit window routinely crosses midnight, and a
 * column running 14:52 → 01:15 with no date cannot be told from a sort that
 * has gone wrong.
 */
export const stamp = (ms: number | undefined): string =>
  (ms === undefined || !Number.isFinite(ms)
    ? '—'
    : `<time data-ts="${ms}">${new Date(ms).toISOString().slice(5, 23).replace('T', ' ')}</time>`)

export interface Figure { k: string; v: string; n?: string; cls?: string }

export interface PageOptions {
  /** Browser tab and file title. */
  title: string
  /** Eyebrow: which product line this report belongs to. */
  eyebrow: string
  h1: string
  lede?: string
  /** The chips under the title: account, generated-at, data window. */
  ident?: string[]
  /** The figures above the fold. */
  figures?: Figure[]
  /** Body HTML — the caller escapes its own content. */
  body: string
  /** How the numbers were derived. Without it the reader can only guess. */
  footer: string
  /** Extra in-page script, injected after the legend toggle. */
  script?: string
}

const REPORT_CSS = `:root{
  --ground:#F4F6F8;--surface:#FFF;--surface-2:#EAEEF3;
  --ink:#141A24;--ink-2:#4E596B;--ink-3:#808B9C;
  --rule:#D9DEE6;--rule-2:#C2CAD6;
  --accent:#2E4A8C;--accent-soft:#E4EAF6;
  --loss:#A8342A;--loss-soft:#F6E3E0;
  --gain:#1C6B58;--warn:#8A6210;
  --f-serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,"Songti SC","Source Han Serif SC",serif;
  --f-sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --f-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0E1218;--surface:#151A22;--surface-2:#1C222C;
  --ink:#E3E8F0;--ink-2:#97A2B3;--ink-3:#6B7688;
  --rule:#232B37;--rule-2:#333D4C;
  --accent:#7D9BE2;--accent-soft:#1B2740;
  --loss:#E4796A;--loss-soft:#33201D;--gain:#54B79D;--warn:#D7A34C;
}}
:root[data-theme="dark"]{
  --ground:#0E1218;--surface:#151A22;--surface-2:#1C222C;
  --ink:#E3E8F0;--ink-2:#97A2B3;--ink-3:#6B7688;
  --rule:#232B37;--rule-2:#333D4C;
  --accent:#7D9BE2;--accent-soft:#1B2740;
  --loss:#E4796A;--loss-soft:#33201D;--gain:#54B79D;--warn:#D7A34C;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--f-serif);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1240px;margin:0 auto;padding:0 22px 80px}
header{border-bottom:1px solid var(--rule);padding:48px 0 24px;margin-bottom:32px;display:flex;flex-direction:column;gap:14px}
.eyebrow{font-family:var(--f-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3)}
h1{font-size:clamp(28px,4vw,42px);font-weight:600;margin:0;line-height:1.14;letter-spacing:-.01em;text-wrap:balance}
h3{font-size:21px;font-weight:600;margin:0 0 8px;letter-spacing:-.01em}
h4{font-family:var(--f-sans);font-size:15px;font-weight:600;margin:26px 0 8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}
h4 code{font-family:var(--f-mono);font-size:14px;background:var(--surface-2);padding:1px 6px;border-radius:2px}
.sub{font-family:var(--f-sans);font-size:12.5px;font-weight:400;color:var(--ink-3)}
section{margin:0 0 52px;padding-top:8px;border-top:1px solid var(--rule)}
section:first-of-type{border-top:none}
.ident{display:flex;flex-wrap:wrap;gap:7px 9px;margin:0 0 18px;font-family:var(--f-mono);font-size:12px;color:var(--ink-2)}
.ident span{background:var(--surface-2);border:1px solid var(--rule);padding:3px 9px;border-radius:2px}
.ident .hot{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin:0 0 36px}
.fig{background:var(--surface);padding:16px 18px;display:flex;flex-direction:column;gap:4px}
.fig .k{font-family:var(--f-sans);font-size:12px;color:var(--ink-3)}
.fig .v{font-family:var(--f-mono);font-size:24px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.fig .n{font-family:var(--f-sans);font-size:11.5px;color:var(--ink-3)}
.pos{color:var(--gain)}.neg{color:var(--loss)}.dim{color:var(--ink-3)}.warn{color:var(--warn)}
.chart{background:var(--surface);border:1px solid var(--rule);padding:16px 14px 8px;overflow-x:auto;margin:0 0 10px}
.chart svg{display:block;min-width:700px;width:100%;height:auto}
.grid{stroke:var(--rule);stroke-width:1}
.ytick,.xtick{font-family:var(--f-mono);font-size:10.5px;fill:var(--ink-3)}
.ytick{text-anchor:end}.xtick{text-anchor:middle}
.tzero{stroke:var(--accent);stroke-width:1.5}
.tlabel{font-family:var(--f-mono);font-size:10.5px;fill:var(--accent)}
.charge{stroke:var(--warn);stroke-width:1.5;stroke-dasharray:5 3}
.clabel{font-family:var(--f-mono);font-size:10.5px;fill:var(--warn)}
.line{fill:none;stroke:var(--ink-2);stroke-width:1.7;stroke-linejoin:round}
.dot-open{fill:var(--accent);fill-opacity:.55;stroke:var(--accent);stroke-width:1}
.dot-close{fill:var(--loss);fill-opacity:.55;stroke:var(--loss);stroke-width:1}
.plan{stroke:var(--loss);stroke-width:1.4;opacity:.75}
.drift{stroke:var(--loss);stroke-width:1;stroke-dasharray:2 3;opacity:.4}
.legend{display:flex;flex-wrap:wrap;gap:5px 20px;font-family:var(--f-sans);font-size:12px;color:var(--ink-2);margin:0 0 8px}
.legend i{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:-1px}
.legend .k-open{background:var(--accent)}.legend .k-close{background:var(--loss)}
.legend .k-line{width:16px;height:2px;border-radius:0;background:var(--ink-2);vertical-align:4px}
.legend .k-drift{width:16px;height:0;border-radius:0;border-top:2px dashed var(--loss);vertical-align:4px}
.legend .hint{color:var(--ink-3)}
.legend .clip{color:var(--warn);font-style:italic}
.tblwrap{overflow-x:auto;border:1px solid var(--rule);background:var(--surface);margin:0 0 8px}
table{border-collapse:collapse;width:100%;min-width:960px}
table.slim{min-width:560px}
th{font-family:var(--f-sans);font-size:11px;font-weight:600;color:var(--ink-3);text-align:right;padding:8px 10px;border-bottom:1px solid var(--rule-2);background:var(--surface);position:sticky;top:0;white-space:nowrap}
td{font-family:var(--f-mono);font-size:12px;font-variant-numeric:tabular-nums;text-align:right;padding:4px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
th.l,td.l{text-align:left}
tbody tr:hover td{background:var(--surface-2)}
tr.late td{background:var(--loss-soft)}
tr.late td:first-child{box-shadow:inset 3px 0 0 var(--loss)}
tr.big td{font-weight:600}
tr.mark td{background:var(--accent-soft);color:var(--accent);font-family:var(--f-sans);font-size:12px;text-align:left;padding:6px 10px;border-bottom:1px solid var(--accent)}
tfoot td{border-top:1px solid var(--rule-2);border-bottom:none;background:var(--surface-2);font-weight:600}
.flag{color:var(--loss);font-family:var(--f-sans);font-size:11.5px}
.bar{display:inline-block;height:7px;background:var(--loss);opacity:.5;vertical-align:middle;margin-left:7px;border-radius:1px}
.bar.g{background:var(--gain)}
.totals{display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:14px}
.totals>div{background:var(--surface);padding:11px 16px;display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
.totals .k{font-family:var(--f-sans);font-size:12px;color:var(--ink-3);min-width:70px}
.totals .v{font-family:var(--f-mono);font-size:13.5px;font-variant-numeric:tabular-nums}
.note{font-family:var(--f-sans);font-size:13px;color:var(--ink-3);margin:6px 0 0}
.alarm{font-family:var(--f-sans);font-size:13.5px;color:var(--loss);background:var(--loss-soft);border-left:3px solid var(--loss);padding:10px 14px;margin:8px 0 0}
.empty{font-family:var(--f-sans);font-size:13px;color:var(--ink-3);background:var(--surface);border:1px solid var(--rule);padding:14px 16px;margin:0 0 10px}
.lede{font-size:17px;color:var(--ink-2);max-width:66ch;margin:0 0 26px}
/* A report is read as a table first and a document second. The prose that
   explains how each column is derived matters once, and after that it is a
   wall between the reader and the numbers — so it starts folded away and the
   header carries the switch. Scoped to PARAGRAPHS: dim is also a cell class
   and a span class, and those are data. */
.prose{display:inline-flex;align-items:center;gap:8px;margin:0 0 18px;font-family:var(--f-mono);font-size:12px;color:var(--ink-3);cursor:pointer;user-select:none}
.prose input{appearance:none;-webkit-appearance:none;width:30px;height:16px;margin:0;border-radius:9px;background:var(--surface-2);border:1px solid var(--rule);position:relative;cursor:pointer;transition:background .12s,border-color .12s}
.prose input::after{content:"";position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:var(--ink-3);transition:transform .12s,background .12s}
.prose input:checked{background:var(--accent-soft);border-color:var(--accent)}
.prose input:checked::after{transform:translateX(14px);background:var(--accent)}
.prose input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* Timestamps are written UTC, because a report is usually read somewhere
   other than where it was produced; the switch is next to Notes so the two
   reader-preference controls live in one place. */
.prose.tz{margin-left:18px}
body.terse p.lede,body.terse p.dim,body.terse p.note,body.terse footer{display:none}
/* A jump target must not sit flush against the top: a heading hidden under
   the toolbar is a jump that did not arrive. */
section[id],h3[id],h4[id]{scroll-margin-top:18px}
a.jump{color:inherit;text-decoration:none;border-bottom:1px dotted var(--rule-2)}
a.jump:hover{color:var(--accent);border-bottom-color:var(--accent)}
tr.jump{cursor:pointer}
tr.jump:hover td{background:var(--accent-soft)}
.toc{display:flex;flex-wrap:wrap;gap:6px 8px;margin:0 0 30px}
.toc a{font-family:var(--f-sans);font-size:12.5px;color:var(--ink-2);background:var(--surface-2);
  border:1px solid var(--rule);border-radius:2px;padding:4px 10px;text-decoration:none}
.toc a:hover{color:var(--accent);border-color:var(--accent)}
.keys{display:flex;flex-wrap:wrap;gap:5px 6px;margin:0 0 10px;align-items:center}
.keys button{font-family:var(--f-sans);font-size:12px;color:var(--ink-2);background:var(--surface);
  border:1px solid var(--rule);border-radius:2px;padding:2px 9px;cursor:pointer;display:inline-flex;
  align-items:center;gap:6px;line-height:1.7}
.keys button:hover{border-color:var(--accent)}
.keys button i{width:9px;height:9px;border-radius:50%;display:inline-block;background:currentColor}
.keys button.off{opacity:.42;text-decoration:line-through}
.keys .all{color:var(--ink-3)}
footer{border-top:1px solid var(--rule);padding-top:18px;font-family:var(--f-sans);font-size:12.5px;color:var(--ink-3);max-width:78ch}
footer code{font-family:var(--f-mono);font-size:11.5px}`

/**
 * The legend's switches.
 *
 * The server draws the SVG, so **the chart is whole without any script** —
 * this only hides and shows. If the JS breaks, is blocked, or is simply
 * wrong, the reader loses the interaction, not the picture.
 *
 * Hiding a series has to rescale the y axis too: the reason to hide one is
 * usually that it stretches the axis until everything else is a flat line,
 * and without the rescale the click changes nothing. The rescale is an SVG
 * transform rather than a redraw — the paths go in a <g>, it is scaled
 * vertically, and the tick labels and right-hand labels are rewritten to the
 * new scale. Stroke width is pinned with vector-effect, or scaling would
 * thicken it too.
 *
 * No localStorage: inside a sandboxed iframe this file is an opaque origin,
 * where touching storage throws.
 */
/* `terse` ships ON in the markup, so the prose never flashes before the
   script runs. The stored preference only ever turns it back off. */
const PROSE_JS = `
(function(){
  var box = document.getElementById('prose'); if(!box) return;
  var show = false;
  try { show = localStorage.getItem('ow-report-prose') === '1' } catch(e) {}
  box.checked = show;
  document.body.classList.toggle('terse', !show);
  box.addEventListener('change', function(){
    document.body.classList.toggle('terse', !box.checked);
    try { localStorage.setItem('ow-report-prose', box.checked ? '1' : '0') } catch(e) {}
  });
})();
`

/*
 * UTC or the reader's own clock.
 *
 * Every `<time data-ts>` in the page is rewritten in place, and the choice is
 * announced so anything that draws its own timestamps — a chart axis, a
 * tooltip — can follow without knowing about this code. It is published on
 * the root element too, so CSS and late-rendered nodes can read it.
 *
 * UTC stays the default and the markup's own value: a report mailed to
 * someone else must not silently mean a different hour in their browser than
 * it did in the sender's.
 */
const TZ_JS = `
(function(){
  var box = document.getElementById('tz'); if(!box) return;
  /* Not every report has timestamps. A switch that visibly does nothing is
     worse than no switch, so it only appears where there is something to
     re-zone. */
  if (!document.querySelector('[data-ts]')) {
    var lbl = box.closest('label'); if (lbl) lbl.style.display = 'none';
    return;
  }
  var pad = function(n){ return n < 10 ? '0' + n : '' + n }
  var local = false;
  try { local = localStorage.getItem('ow-report-tz') === 'local' } catch(e) {}

  function fmt(ms){
    var d = new Date(ms);
    var M = local ? d.getMonth() + 1 : d.getUTCMonth() + 1;
    var D = local ? d.getDate() : d.getUTCDate();
    var h = local ? d.getHours() : d.getUTCHours();
    var m = local ? d.getMinutes() : d.getUTCMinutes();
    var s = local ? d.getSeconds() : d.getUTCSeconds();
    var f = local ? d.getMilliseconds() : d.getUTCMilliseconds();
    return pad(M) + '-' + pad(D) + ' ' + pad(h) + ':' + pad(m) + ':' + pad(s) + '.' + String(f).padStart(3, '0');
  }

  function apply(){
    document.documentElement.setAttribute('data-tz', local ? 'local' : 'utc');
    var nodes = document.querySelectorAll('[data-ts]');
    for (var i = 0; i < nodes.length; i++) {
      var v = Number(nodes[i].getAttribute('data-ts'));
      if (isFinite(v)) nodes[i].textContent = fmt(v);
    }
    window.owTz = { local: local, fmt: fmt };
    window.dispatchEvent(new CustomEvent('owtzchange'));
  }

  box.checked = local;
  apply();
  box.addEventListener('change', function(){
    local = box.checked;
    try { localStorage.setItem('ow-report-tz', local ? 'local' : 'utc') } catch(e) {}
    apply();
  });
})();
`

const LEGEND_JS = `
(function(){
  function num(el, name, dflt){ var v = parseFloat(el.getAttribute(name)); return isNaN(v) ? dflt : v }
  document.querySelectorAll('.keys[data-chart]').forEach(function(keys){
    var id = keys.getAttribute('data-chart')
    var svg = document.querySelector('svg[data-chart="' + id + '"]')
    if (!svg) return
    var plot = svg.querySelector('.plot')
    var cfg = svg.getAttribute('data-plot')
    var P = cfg ? JSON.parse(cfg) : null
    var btns = [].slice.call(keys.querySelectorAll('button[data-key]'))

    function apply(){
      var on = btns.filter(function(b){ return !b.classList.contains('off') })
      btns.forEach(function(b){
        var hide = b.classList.contains('off')
        svg.querySelectorAll('[data-series="' + b.getAttribute('data-key') + '"]').forEach(function(el){
          el.style.display = hide ? 'none' : ''
        })
      })
      if (!P || !plot) return
      // All off: keep the original scale — no division by zero, and no blank
      // chart whose ticks have wandered.
      var lo = Infinity, hi = -Infinity
      on.forEach(function(b){ lo = Math.min(lo, num(b, 'data-min', 0)); hi = Math.max(hi, num(b, 'data-max', 0)) })
      if (!isFinite(lo) || !isFinite(hi)) { lo = P.lo; hi = P.hi }
      var padv = (hi - lo) * 0.1 || 0.1
      lo -= padv; hi += padv
      var span = (hi - lo) || 1
      var a = (P.hi - P.lo) / span
      var b2 = P.tp + (hi - P.hi) * P.ph / span - P.tp * a
      plot.setAttribute('transform', 'translate(0,' + b2.toFixed(3) + ') scale(1,' + a.toFixed(6) + ')')
      svg.querySelectorAll('[data-tick]').forEach(function(t){
        var i = parseInt(t.getAttribute('data-tick'), 10)
        var v = lo + (hi - lo) * i / 4
        t.textContent = (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
        t.setAttribute('y', (P.tp + (hi - v) / span * P.ph + 4).toFixed(1))
      })
      svg.querySelectorAll('[data-last]').forEach(function(t){
        var v = num(t, 'data-last', 0)
        t.setAttribute('y', (P.tp + (hi - v) / span * P.ph + 4).toFixed(1))
      })
    }

    btns.forEach(function(b){
      b.addEventListener('click', function(){ b.classList.toggle('off'); apply() })
    })
    keys.querySelectorAll('button[data-all]').forEach(function(b){
      b.addEventListener('click', function(){
        var want = b.getAttribute('data-all') === 'off'
        btns.forEach(function(x){ x.classList.toggle('off', want) })
        apply()
      })
    })
  })
})();
`

/** A whole document rather than a fragment — see the note at the top. */
export function page(o: PageOptions): string {
  const figs = (o.figures ?? []).length === 0 ? '' : `<div class="figs">${
    o.figures!.map(f => `<div class="fig"><span class="k">${esc(f.k)}</span>`
      + `<span class="v${f.cls ? ` ${f.cls}` : ''}">${esc(f.v)}</span>`
      + `${f.n !== undefined ? `<span class="n">${esc(f.n)}</span>` : ''}</div>`).join('')
  }</div>`
  const ident = (o.ident ?? []).length === 0 ? '' : `<p class="ident">${
    o.ident!.map(t => `<span>${esc(t)}</span>`).join('')
  }</p>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<style>
${REPORT_CSS}
</style>
</head>
<body class="terse">
<div class="wrap">
<header>
  <div class="eyebrow">${esc(o.eyebrow)}</div>
  <h1>${esc(o.h1)}</h1>
  <label class="prose"><input type="checkbox" id="prose"><span>Notes</span></label>
  <label class="prose tz"><input type="checkbox" id="tz"><span>Local time</span></label>
  ${o.lede !== undefined ? `<p class="lede">${esc(o.lede)}</p>` : ''}
  ${ident}
</header>
${figs}
${o.body}
<footer>${o.footer}</footer>
</div>
<script>${PROSE_JS}${TZ_JS}${LEGEND_JS}${o.script ?? ''}</script>
</body>
</html>`
}
