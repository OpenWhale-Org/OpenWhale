'use client'

import { useState, type ReactNode } from 'react'
import type { CredentialWithPublicData } from '@/lib/data'
import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'
import { useT } from '@/i18n'

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
const TG_UPDATES_URL = 'api.telegram.org/bot<token>/getUpdates'

const input = {
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
} as const

/**
 * A message with one product name set in mono — the name keeps its typeface
 * whatever the sentence around it turns into. `slot` is the filled value, so
 * the split works on the translated string.
 */
function withMono(message: string, slot: string): ReactNode {
  const at = message.indexOf(slot)
  if (at < 0) return message
  return <>{message.slice(0, at)}<span className="mono">{slot}</span>{message.slice(at + slot.length)}</>
}

export function AlertsClient({ initialSettings, credentials }: {
  initialSettings: AlertSettings
  credentials: CredentialWithPublicData[]
}) {
  const t = useT()
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
      if (!res.ok) { setNotice({ ok: false, text: await res.text() || t('alerts.saveFailed') }); return null }
      const saved = await res.json() as AlertSettings
      setS(saved)
      setToText((saved.emailTo ?? []).join(', '))
      setNotice({ ok: true, text: t('alerts.saved') })
      return saved
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : t('alerts.networkError') })
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
      if (!res.ok) { setNotice({ ok: false, text: body.error ?? t('alerts.testFailed') }); return }
      const parts: string[] = []
      if (body.sent?.length) parts.push(t('alerts.sentOn', { channels: body.sent.join(t('alerts.and')) }))
      for (const f of body.failed ?? []) parts.push(t('alerts.channelFailed', { channel: f.channel, error: f.error }))
      setNotice({ ok: !(body.failed?.length), text: parts.join(' · ') || t('alerts.nothingSent') })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : t('alerts.networkError') })
    } finally {
      setTesting(false)
    }
  }

  const noChannel = !(s.emailCredential && recipients.length > 0) && !(s.telegramCredential && s.telegramChatId)

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">{t('alerts.title')}</h1>
      <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
        {t('alerts.intro')}
      </p>

      <div className="mb-6">
        <Switch
          checked={s.enabled}
          onChange={(enabled) => patch({ enabled })}
          label={<span className="font-medium">{t('alerts.send')}</span>}
          hint={t('alerts.sendHint')}
        />
      </div>

      {/* ── Email ─────────────────────────────────────────────────────────── */}
      <section
        className="rounded-lg p-4 mb-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-sm font-medium mb-3">{t('alerts.email')}</h2>
        {emailCreds.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {withMono(t('alerts.noEmailCredential', { types: t('alerts.emailTypes') }), t('alerts.emailTypes'))}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>{t('alerts.credential')}</label>
              <Select
                value={s.emailCredential ?? ''}
                onChange={(v) => patch(v ? { emailCredential: v } : { emailCredential: undefined as never })}
                placeholder={t('alerts.none')}
                options={[
                  { value: '', label: t('alerts.none') },
                  ...emailCreds.map(c => ({ value: c.name, label: c.name, hint: c.type })),
                ]}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>
                {t('alerts.sendTo')} <span style={{ color: 'var(--border)' }}>{t('alerts.commaSeparated')}</span>
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
        <h2 className="text-sm font-medium mb-3">{t('alerts.telegram')}</h2>
        {tgCreds.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {withMono(t('alerts.noBot', { type: t('alerts.botType') }), t('alerts.botType'))}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>{t('alerts.bot')}</label>
              <Select
                value={s.telegramCredential ?? ''}
                onChange={(v) => patch(v ? { telegramCredential: v } : { telegramCredential: undefined as never })}
                placeholder={t('alerts.none')}
                options={[
                  { value: '', label: t('alerts.none') },
                  ...tgCreds.map(c => ({ value: c.name, label: c.name, hint: c.type })),
                ]}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>{t('alerts.chatId')}</label>
              <input
                value={s.telegramChatId ?? ''}
                onChange={(e) => patch({ telegramChatId: e.target.value })}
                placeholder="-1001234567890"
                className="w-full text-sm px-2 py-1.5 rounded-md mono"
                style={input}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                {withMono(t('alerts.chatIdHint', { url: TG_UPDATES_URL }), TG_UPDATES_URL)}
              </p>
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center gap-2">
        <button onClick={() => void save()} disabled={saving} className="btn btn-primary">
          {saving ? t('alerts.saving') : t('common.save')}
        </button>
        <button
          onClick={() => void test()}
          disabled={testing || saving || noChannel}
          className="btn btn-secondary"
          title={noChannel ? t('alerts.testTitleNoChannel') : t('alerts.testTitle')}
        >
          {testing ? t('alerts.sending') : t('alerts.sendTest')}
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
