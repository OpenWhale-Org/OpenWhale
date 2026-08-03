'use client'

import { useState } from 'react'

/**
 * The specimen book. Each section shows the canonical form of a control next
 * to the tokens/classes that produce it, so a page refactor is a mechanical
 * "replace ad-hoc styles with the class shown here".
 */

const CORE_TOKENS = [
  { name: '--background', usage: 'App canvas' },
  { name: '--surface', usage: 'Panels, cards, table headers' },
  { name: '--surface-raised', usage: 'Popovers, modals, hovered rows' },
  { name: '--surface-inset', usage: 'Wells: code, chart plots, empty states' },
  { name: '--border', usage: 'Every hairline — 1px, one color' },
  { name: '--foreground', usage: 'Primary text' },
  { name: '--foreground-soft', usage: 'Secondary text: descriptions, metadata' },
  { name: '--muted', usage: 'Tertiary text: labels, captions, axes' },
]

const ACCENT_TOKENS = [
  { name: '--accent', usage: 'THE interactive hue — buttons, links, series, focus' },
  { name: '--accent-hover', usage: 'Hover state of filled accent surfaces' },
  { name: '--accent-soft', usage: 'Selected/active fills behind accent text' },
  { name: '--ring', usage: 'Focus outlines (2px, offset 1px)' },
]

const SEMANTIC_TOKENS = [
  { name: '--success', soft: '--success-soft', usage: 'Confirmed, active, profit' },
  { name: '--warning', soft: '--warning-soft', usage: 'Degraded, pending, caution' },
  { name: '--danger', soft: '--danger-soft', usage: 'Failed, destructive, loss' },
]

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-base font-semibold mb-0.5">{title}</h2>
      <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>{blurb}</p>
      {children}
    </section>
  )
}

function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 flex flex-col gap-3">
      <span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{label}</span>
      {children}
    </div>
  )
}

function Code({ children }: { children: string }) {
  return (
    <code className="mono text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-inset)', color: 'var(--foreground-soft)' }}>
      {children}
    </code>
  )
}

export function UiDesignClient() {
  const [toggleOn, setToggleOn] = useState(true)
  const [slider, setSlider] = useState(65)
  const [tab, setTab] = useState('Positions')
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div>
      {/* ── Principles ── */}
      <Section
        title="Principles"
        blurb="What every screen optimizes for. When two rules conflict, the earlier one wins."
      >
        <ol className="card p-4 text-sm flex flex-col gap-2 list-decimal list-inside" style={{ color: 'var(--foreground-soft)' }}>
          <li><b style={{ color: 'var(--foreground)' }}>Data forward, chrome recessive.</b> Panels and borders never compete with numbers and charts.</li>
          <li><b style={{ color: 'var(--foreground)' }}>One accent hue.</b> Violet marks the interactive and the selected. Nothing else is violet.</li>
          <li><b style={{ color: 'var(--foreground)' }}>Semantic color means something.</b> Green/amber/red appear only when they carry state or PnL — never as decoration.</li>
          <li><b style={{ color: 'var(--foreground)' }}>Dense by default.</b> Tables and forms use the small scale (13px controls, 12px metadata). Space is for grouping, not for air.</li>
          <li><b style={{ color: 'var(--foreground)' }}>Numbers are tabular.</b> Anything that updates or aligns in columns uses <Code>.tabular</Code> or <Code>.mono</Code>.</li>
        </ol>
      </Section>

      {/* ── Color ── */}
      <Section title="Color tokens" blurb="All colors come from CSS variables in globals.css. No page defines its own hex values.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Specimen label="Neutrals">
            <div className="flex flex-col gap-1.5">
              {CORE_TOKENS.map(t => (
                <div key={t.name} className="flex items-center gap-3 text-xs">
                  <span className="inline-block w-8 h-5 rounded border" style={{ background: `var(${t.name})`, borderColor: 'var(--border)' }} />
                  <Code>{t.name}</Code>
                  <span style={{ color: 'var(--foreground-soft)' }}>{t.usage}</span>
                </div>
              ))}
            </div>
          </Specimen>
          <div className="flex flex-col gap-3">
            <Specimen label="Accent">
              <div className="flex flex-col gap-1.5">
                {ACCENT_TOKENS.map(t => (
                  <div key={t.name} className="flex items-center gap-3 text-xs">
                    <span className="inline-block w-8 h-5 rounded border" style={{ background: `var(${t.name})`, borderColor: 'var(--border)' }} />
                    <Code>{t.name}</Code>
                    <span style={{ color: 'var(--foreground-soft)' }}>{t.usage}</span>
                  </div>
                ))}
              </div>
            </Specimen>
            <Specimen label="Semantics — solid for text/lines, soft for fills">
              <div className="flex flex-col gap-1.5">
                {SEMANTIC_TOKENS.map(t => (
                  <div key={t.name} className="flex items-center gap-3 text-xs">
                    <span className="inline-block w-8 h-5 rounded border" style={{ background: `var(${t.name})`, borderColor: 'var(--border)' }} />
                    <span className="inline-block w-8 h-5 rounded border" style={{ background: `var(${t.soft})`, borderColor: 'var(--border)' }} />
                    <Code>{t.name}</Code>
                    <span style={{ color: 'var(--foreground-soft)' }}>{t.usage}</span>
                  </div>
                ))}
              </div>
            </Specimen>
          </div>
        </div>
      </Section>

      {/* ── Typography ── */}
      <Section title="Typography" blurb="Inter for UI, the system mono stack for identifiers and streaming numbers. Four sizes cover the whole dashboard.">
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-baseline gap-4"><span className="text-2xl font-semibold">Page title</span><Code>text-2xl font-semibold</Code><span className="text-xs" style={{ color: 'var(--muted)' }}>one per page</span></div>
          <div className="flex items-baseline gap-4"><span className="text-base font-semibold">Section heading</span><Code>text-base font-semibold</Code></div>
          <div className="flex items-baseline gap-4"><span className="text-sm">Body & controls</span><Code>text-sm / 13px controls</Code></div>
          <div className="flex items-baseline gap-4"><span className="text-xs" style={{ color: 'var(--foreground-soft)' }}>Metadata & descriptions</span><Code>text-xs + --foreground-soft</Code></div>
          <div className="flex items-baseline gap-4"><span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Overline label</span><Code>text-[11px] uppercase tracking-wider + --muted</Code></div>
          <div className="flex items-baseline gap-4"><span className="mono tabular text-sm">0.067409 · −0.22% · $60,285.83</span><Code>.mono .tabular</Code><span className="text-xs" style={{ color: 'var(--muted)' }}>prices, rates, ids</span></div>
        </div>
      </Section>

      {/* ── Geometry ── */}
      <Section title="Geometry" blurb="Two radii, one border, three gaps. Elevation is a background step, not a shadow.">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Specimen label="Radius">
            <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--foreground-soft)' }}>
              <span className="inline-block w-14 h-9 rounded-md border" style={{ borderColor: 'var(--border)' }} />
              <span><Code>rounded-md</Code> controls</span>
            </div>
            <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--foreground-soft)' }}>
              <span className="inline-block w-14 h-9 rounded-lg border" style={{ borderColor: 'var(--border)' }} />
              <span><Code>rounded-lg</Code> cards & panels</span>
            </div>
          </Specimen>
          <Specimen label="Spacing rhythm">
            <ul className="text-xs flex flex-col gap-1" style={{ color: 'var(--foreground-soft)' }}>
              <li><Code>gap-1.5 / gap-2</Code> — inside a control group</li>
              <li><Code>gap-3 / p-4</Code> — inside a card</li>
              <li><Code>gap-6 / mb-10</Code> — between sections</li>
            </ul>
          </Specimen>
          <Specimen label="Elevation = lighter surface">
            <div className="rounded-lg p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <div className="rounded-md p-3 text-xs" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--foreground-soft)' }}>
                raised (popover) on surface — no drop shadows
              </div>
            </div>
          </Specimen>
        </div>
      </Section>

      {/* ── Buttons ── */}
      <Section title="Buttons" blurb="Four variants, two sizes. Variants change color only; geometry never moves. Primary appears at most once per view.">
        <div className="card p-4 flex flex-col gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button className="btn btn-primary">Primary</button>
            <button className="btn btn-secondary">Secondary</button>
            <button className="btn btn-ghost">Ghost</button>
            <button className="btn btn-danger">Danger</button>
            <button className="btn btn-primary" disabled>Disabled</button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button className="btn btn-sm btn-primary">Small primary</button>
            <button className="btn btn-sm btn-secondary">Small secondary</button>
            <button className="btn btn-sm btn-ghost">⟳ Refresh</button>
            <button className="btn btn-sm btn-danger">Delete</button>
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            <Code>.btn</Code> + <Code>.btn-primary|secondary|ghost|danger</Code>, add <Code>.btn-sm</Code> for table rows and toolbars.
            Danger is outlined until hovered — destructive intent must be deliberate.
          </p>
        </div>
      </Section>

      {/* ── Forms ── */}
      <Section title="Form controls" blurb="One height (32px), one focus treatment (accent border + ring). Labels sit above in overline style; hints below in metadata style.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Specimen label="Text / number / select / textarea — .input">
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted)' }}>Instance name</label>
                <input className="input" placeholder="e.g. HL–BN funding cycle" />
                <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Shown on the board and in notifications.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted)' }}>Max notional</label>
                  <input className="input tabular" type="number" defaultValue={1000} />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted)' }}>Venue</label>
                  <select className="input" defaultValue="hyperliquid">
                    <option value="hyperliquid">hyperliquid</option>
                    <option value="binance">binance</option>
                  </select>
                </div>
              </div>
              <textarea className="input" rows={2} placeholder="Notes…" />
            </div>
          </Specimen>
          <Specimen label="Toggle · checkbox · slider">
            <div className="flex flex-col gap-4">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm">Dry run</span>
                <button
                  role="switch"
                  aria-checked={toggleOn}
                  onClick={() => setToggleOn(v => !v)}
                  className="relative w-9 h-5 rounded-full transition-colors"
                  style={{ background: toggleOn ? 'var(--accent)' : 'var(--surface-raised)', border: '1px solid var(--border)' }}
                >
                  <span
                    className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all"
                    style={{ left: toggleOn ? 'calc(100% - 1.125rem)' : '0.125rem' }}
                  />
                </button>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" defaultChecked className="w-3.5 h-3.5" style={{ accentColor: 'var(--accent)' }} />
                Skip held symbols
              </label>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span style={{ color: 'var(--muted)' }}>Margin usage</span>
                  <span className="tabular">{slider}%</span>
                </div>
                <input
                  type="range" min={0} max={100} value={slider}
                  onChange={e => setSlider(Number(e.target.value))}
                  className="w-full" style={{ accentColor: 'var(--accent)' }}
                />
              </div>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Native <Code>accent-color: var(--accent)</Code> for checkbox/range; the switch is the one custom control.
              </p>
            </div>
          </Specimen>
        </div>
      </Section>

      {/* ── Badges ── */}
      <Section title="Badges & status" blurb="Soft fill + solid text of the same semantic. Neutral for taxonomy, accent for selection, semantics for state.">
        <div className="card p-4 flex items-center gap-2 flex-wrap">
          <span className="badge badge-success">ready</span>
          <span className="badge badge-success">active</span>
          <span className="badge badge-warning">pending</span>
          <span className="badge badge-danger">failed</span>
          <span className="badge badge-neutral">simulate</span>
          <span className="badge badge-accent">selected</span>
          <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}><Code>.badge .badge-success|warning|danger|neutral|accent</Code></span>
        </div>
      </Section>

      {/* ── Tabs ── */}
      <Section title="Tabs" blurb="Underline marks the active pane; the label brightens. No pill backgrounds for navigation-within-a-page.">
        <div className="card p-4">
          <div className="flex gap-4 border-b" style={{ borderColor: 'var(--border)' }}>
            {['Positions', 'Executions', 'Runs', 'Logs'].map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="pb-2 text-sm -mb-px border-b-2 transition-colors"
                style={{
                  borderColor: tab === t ? 'var(--accent)' : 'transparent',
                  color: tab === t ? 'var(--foreground)' : 'var(--muted)',
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="text-xs pt-3" style={{ color: 'var(--foreground-soft)' }}>“{tab}” pane content…</p>
        </div>
      </Section>

      {/* ── Table ── */}
      <Section title="Tables" blurb="Header in surface + overline type; rows separated by hairlines; numbers right-aligned and tabular; row hover raises the surface.">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--surface)' }}>
                {['Symbol', 'Side', 'Notional', 'uPnL', 'Status'].map((h, i) => (
                  <th key={h} className={`px-3 py-2 text-[11px] uppercase tracking-wider font-medium ${i >= 2 && i <= 3 ? 'text-right' : 'text-left'}`} style={{ color: 'var(--muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { sym: 'HYPER/USDC:USDC', side: 'long', notional: '$1,178.55', pnl: '+$6.10', up: true, status: 'active' },
                { sym: 'XYZ-SKHX/USDC:USDC', side: 'short', notional: '$3,204.55', pnl: '−$12.40', up: false, status: 'active' },
              ].map(r => (
                <tr key={r.sym} className="border-t transition-colors hover:[background:var(--surface-raised)]" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2 mono text-xs">{r.sym}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: r.side === 'long' ? 'var(--success)' : 'var(--danger)' }}>{r.side}</td>
                  <td className="px-3 py-2 text-right tabular">{r.notional}</td>
                  <td className="px-3 py-2 text-right tabular" style={{ color: r.up ? 'var(--success)' : 'var(--danger)' }}>{r.pnl}</td>
                  <td className="px-3 py-2"><span className="badge badge-success">{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── Charts ── */}
      <Section title="Charts" blurb="2px accent line, hairline grid, direct-labeled last value, dashed muted crosshair, tooltip on raised surface. Plot area sits on the inset surface.">
        <div className="card p-4">
          <svg viewBox="0 0 560 120" className="w-full" style={{ display: 'block', height: 120 }}>
            <rect x="0" y="0" width="500" height="104" fill="var(--surface-inset)" rx="4" />
            {[26, 52, 78].map(y => (
              <g key={y}>
                <line x1="8" x2="492" y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
                <text x="506" y={y + 3} fontSize="10" fill="var(--muted)">${(420 - y).toFixed(0)}</text>
              </g>
            ))}
            <path d="M8,60 L90,58 L140,70 L200,40 L260,44 L320,30 L380,52 L440,36 L482,42" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            <line x1="320" x2="320" y1="8" y2="96" stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
            <circle cx="320" cy="30" r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
            <circle cx="482" cy="42" r="3" fill="var(--accent)" />
            <g>
              <rect x="330" y="10" width="104" height="34" rx="4" fill="var(--surface-raised)" stroke="var(--border)" />
              <text x="338" y="24" fontSize="10" fill="var(--foreground)">$390.12</text>
              <text x="338" y="37" fontSize="9" fill="var(--muted)">08-02 16:35:00</text>
            </g>
          </svg>
          <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
            Multi-series panels reuse the accent first, then <Code>#38bdf8</Code>, <Code>#f472b6</Code>, <Code>#facc15</Code> — semantics stay reserved for meaning.
            The viewBox width must follow the container (ResizeObserver) so text renders 1:1.
          </p>
        </div>

        <div className="card p-4 mt-3">
          <span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            Scatter — a relationship, not a sequence
          </span>
          <svg viewBox="0 0 560 120" className="w-full mt-2" style={{ display: 'block', height: 120 }}>
            <rect x="0" y="0" width="500" height="104" fill="var(--surface-inset)" rx="4" />
            {[26, 52, 78].map(y => <line key={y} x1="8" x2="492" y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />)}
            <path d="M20,62 L250,50 L480,28 L480,48 L250,58 L20,82 Z" fill="var(--accent)" opacity="0.13" />
            <path d="M20,72 L480,38" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="6 4" opacity="0.9" />
            {[[40, 80], [78, 66], [112, 88], [150, 60], [186, 74], [222, 52], [258, 66], [292, 44], [330, 58], [366, 36], [400, 50], [438, 30], [468, 44]].map(([cx, cy]) => (
              <circle key={`${cx}`} cx={cx} cy={cy} r="4" fill="var(--accent)" fillOpacity="0.62" stroke="var(--surface)" strokeWidth="1.5" />
            ))}
            <text x="506" y="55" fontSize="10" fill="var(--muted)">ms</text>
          </svg>
          <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
            When x is a measured quantity rather than time, points are never connected — a line through a cloud invents an order the data does not have.
            The form is <Code>kind: &apos;scatter&apos;</Code>: 8px dots at 62% fill with a surface ring so overlaps stay countable,
            a dashed 2px least-squares trend, and its <b style={{ color: 'var(--foreground-soft)' }}>95% confidence band</b> as a 13% fill —
            the band is the honesty layer, since a bare trend line always looks certain. The legend carries <Code>R²</Code>, the slope and <Code>n</Code>;
            hover targets the nearest point within 24px rather than a shared x.
          </p>
        </div>
      </Section>

      {/* ── Overlays ── */}
      <Section title="Overlays" blurb="Popovers and modals live on the raised surface with a hairline — no shadows, no blur. Modals dim the canvas at 60%.">
        <div className="card p-4 flex items-start gap-6 flex-wrap">
          <div>
            <span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Popover / menu</span>
            <div className="mt-2 w-44 rounded-md p-1" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}>
              {['Rename', 'Move to folder', 'Change icon'].map(item => (
                <button key={item} className="w-full text-left text-sm px-2 py-1.5 rounded hover:[background:var(--accent-soft)]">{item}</button>
              ))}
              <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
              <button className="w-full text-left text-sm px-2 py-1.5 rounded" style={{ color: 'var(--danger)' }}>Delete</button>
            </div>
          </div>
          <div>
            <span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Modal</span>
            <div className="mt-2">
              <button className="btn btn-secondary" onClick={() => setModalOpen(true)}>Open modal demo</button>
            </div>
            {modalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setModalOpen(false)}>
                <div className="w-96 rounded-lg p-5" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                  <h3 className="text-base font-semibold mb-1">Deactivate instance?</h3>
                  <p className="text-sm mb-4" style={{ color: 'var(--foreground-soft)' }}>
                    Live cycles keep their positions; the timed backstop re-arms on the next activation.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button className="btn btn-ghost" onClick={() => setModalOpen(false)}>Cancel</button>
                    <button className="btn btn-primary" onClick={() => setModalOpen(false)}>Deactivate</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* ── Feedback ── */}
      <Section title="Feedback" blurb="Banners for page-level state, inline empty/loading states inside the panel they describe. Sentence-case, one line, actionable.">
        <div className="flex flex-col gap-3">
          <div className="rounded-md px-3 py-2 text-sm flex items-center gap-2" style={{ background: 'var(--success-soft)', color: 'var(--success)', border: '1px solid transparent' }}>
            ✓ Deployed — all services healthy.
          </div>
          <div className="rounded-md px-3 py-2 text-sm flex items-center gap-2" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>
            ⚠ Spread feed stale for 92s — builds paused, exits unaffected.
          </div>
          <div className="rounded-md px-3 py-2 text-sm flex items-center gap-2" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
            ✕ Leg failed: insufficient margin on hyperliquid — pair cooling down.
          </div>
          <div className="card-inset px-3 py-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
            No snapshots yet — equity is sampled every few minutes while the runtime is up.
          </div>
        </div>
      </Section>

      {/* ── Navigation ── */}
      <Section title="Navigation" blurb="Sidebar items: muted at rest, foreground on hover, accent-soft fill + accent text when current.">
        <div className="card p-2 w-52 flex flex-col gap-0.5">
          {[
            { label: 'Instances', active: false },
            { label: 'Accounts', active: true },
            { label: 'Monitor', active: false },
          ].map(l => (
            <span
              key={l.label}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm cursor-pointer"
              style={l.active
                ? { background: 'var(--accent-soft)', color: '#a78bfa' }
                : { color: 'var(--muted)' }}
            >
              <span className="inline-block w-4 h-4 rounded-sm" style={{ background: 'currentColor', opacity: 0.5 }} />
              {l.label}
            </span>
          ))}
        </div>
      </Section>
    </div>
  )
}
