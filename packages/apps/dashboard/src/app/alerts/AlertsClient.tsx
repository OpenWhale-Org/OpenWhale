'use client'

import { useState } from 'react'
import type { CredentialWithPublicData } from '@/lib/data'
import { Select } from '@/components/Select'

/**
 * Where this engine sends its alerts.
 *
 * One configuration, not one per login: a gateway is run by an operator or a
 * small team who all want the same page, and a destination per user would make
 * "was anyone told" a question with as many answers as there are accounts.
 *
 * No secret is typed on this page. The key lives in a Credential, encrypted
 * with everything else; what is chosen here is only which credential to use
 * and where to send.
 */

export interface AlertSettings {
  enabled: boolean
  emailCredential?: string
  emailTo: string[]
  telegramCredential?: string
  telegramChatId?: string
}

const EMAIL_TYPES = ['notify/resend', 'notify/ses', 'notify/smtp']
const TELEGRAM_TYPE = 'notify/telegram'

const input = {
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
} as const

export function AlertsClient({ initialSettings, credentials }: {
  initialSettings: AlertSettings
  credentials: CredentialWithPublicData[]
}) {
  const [s, setS] = useState<AlertSettings>(initialSettings)
  const [toText, setToText] = useState((initialSettings.emailTo ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const emailCreds = credentials.filter(c => EMAIL_TYPES.includes(c.type))
  const tgCreds = credentials.filter(c => c.type === TELEGRAM_TYPE)

  const patch = (p: Partial<AlertSettings>) => { setS(prev => ({ ...prev, ...p })); setNotice(null) }
  const recipients = toText.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)

  async function save(): Promise<AlertSettings | null> {
    setSaving(true)
    setNotice(null)
    try {
      const body: AlertSettings = { ...s, emailTo: recipients }
      const res = await fetch('/api/alerts/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) { setNotice({ ok: false, text: await res.text() || 'Save failed' }); return null }
      const saved = await res.json() as AlertSettings
      setS(saved)
      setToText((saved.emailTo ?? []).join(', '))
      setNotice({ ok: true, text: 'Saved.' })
      return saved
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Network error' })
      return null
    } finally {
      setSaving(false)
    }
  }

  /* Saves first, on purpose: the button means "does what I am looking at
     work", and testing the previously saved configuration while the form
     shows a different one answers a question nobody asked. */
  async function test() {
    if (!await save()) return
    setTesting(true)
    setNotice(null)
    try {
      const res = await fetch('/api/alerts/test', { method: 'POST' })
      const body = await res.json().catch(() => ({})) as {
        sent?: string[]; failed?: Array<{ channel: string; error: string }>; error?: string
      }
      if (!res.ok) { setNotice({ ok: false, text: body.error ?? 'Test failed' }); return }
      const parts: string[] = []
      if (body.sent?.length) parts.push(`sent on ${body.sent.join(' and ')}`)
      for (const f of body.failed ?? []) parts.push(`${f.channel} failed: ${f.error}`)
      setNotice({ ok: !(body.failed?.length), text: parts.join(' · ') || 'Nothing was sent' })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setTesting(false)
    }
  }

  const noChannel = !(s.emailCredential && recipients.length > 0) && !(s.telegramCredential && s.telegramChatId)

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">Alerts</h1>
      <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
        Where this engine tells you an execution failed. Each strategy chooses whether it takes part — under
        Misc on the instance — and every strategy is included until you say otherwise.
      </p>

      <label className="flex items-start gap-3 mb-6 cursor-pointer">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          <span className="text-sm font-medium">Send alerts</span>
          <span className="block text-xs" style={{ color: 'var(--muted)' }}>
            The master switch. Off means nothing is sent, whatever the strategies say.
          </span>
        </span>
      </label>

      {/* ── Email ─────────────────────────────────────────────────────────── */}
      <section
        className="rounded-lg p-4 mb-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-sm font-medium mb-3">Email</h2>
        {emailCreds.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No email credential yet. Add a <span className="mono">Resend</span>, <span className="mono">Amazon SES</span> or{' '}
            <span className="mono">SMTP server</span> credential on the Credentials page, then choose it here.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Credential</label>
              <Select
                value={s.emailCredential ?? ''}
                onChange={(v) => patch(v ? { emailCredential: v } : { emailCredential: undefined as never })}
                placeholder="— none —"
                options={[
                  { value: '', label: '— none —' },
                  ...emailCreds.map(c => ({ value: c.name, label: c.name, hint: c.type })),
                ]}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>
                Send to <span style={{ color: 'var(--border)' }}>· comma separated</span>
              </label>
              <input
                value={toText}
                onChange={(e) => { setToText(e.target.value); setNotice(null) }}
                placeholder="you@example.com, oncall@example.com"
                className="w-full text-sm px-2 py-1.5 rounded-md"
                style={input}
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Telegram ──────────────────────────────────────────────────────── */}
      <section
        className="rounded-lg p-4 mb-6"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-sm font-medium mb-3">Telegram</h2>
        {tgCreds.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            No bot yet. Add a <span className="mono">Telegram bot</span> credential on the Credentials page.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Bot</label>
              <Select
                value={s.telegramCredential ?? ''}
                onChange={(v) => patch(v ? { telegramCredential: v } : { telegramCredential: undefined as never })}
                placeholder="— none —"
                options={[
                  { value: '', label: '— none —' },
                  ...tgCreds.map(c => ({ value: c.name, label: c.name, hint: c.type })),
                ]}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Chat ID</label>
              <input
                value={s.telegramChatId ?? ''}
                onChange={(e) => patch({ telegramChatId: e.target.value })}
                placeholder="-1001234567890"
                className="w-full text-sm px-2 py-1.5 rounded-md mono"
                style={input}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                Message the bot (or add it to the group), then read the id from{' '}
                <span className="mono">api.telegram.org/bot&lt;token&gt;/getUpdates</span>. A group id is negative.
              </p>
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center gap-2">
        <button onClick={() => void save()} disabled={saving} className="btn btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => void test()}
          disabled={testing || saving || noChannel}
          className="btn btn-secondary"
          title={noChannel ? 'Choose a credential and a destination first' : 'Save, then send one message now'}
        >
          {testing ? 'Sending…' : 'Save & send a test'}
        </button>
        {notice && (
          <span className="text-xs" style={{ color: notice.ok ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}
