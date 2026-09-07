import { z } from 'zod'
import type { CredentialTypeDefinition, RawCredentialData } from '@openwhaleorg/core'
import { sendEmail, sendTelegram } from './send.js'

/**
 * Where an alert can be sent.
 *
 * Registered by the GATEWAY rather than by core, because delivery is an
 * operator's concern: what is worth an email, and which relay carries it,
 * belongs to whoever runs the engine, and a mail library has no business in a
 * package every plugin installs.
 *
 * All four are `raw` — the notifier reads the key itself rather than opening a
 * session, since none of these is a venue.
 */

const notify = (over: Partial<CredentialTypeDefinition>): Partial<CredentialTypeDefinition> => ({
  category: 'Alerting',
  raw: true,
  ...over,
})

export const notifyCredentialTypes: CredentialTypeDefinition[] = [
  {
    ...notify({}),
    type: 'notify/resend',
    displayName: 'Resend',
    logo: '/brands/resend.svg',
    icon: '📧',
    description: 'Email over the Resend API. One key, one verified sender.',
    documentationUrl: 'https://resend.com/api-keys',
    schema: z.object({
      apiKey: z.string().meta({ displayName: 'API Key', placeholder: 're_…' }),
      from: z.string().meta({
        displayName: 'From',
        description: 'A sender on a domain you verified with Resend, e.g. alerts@example.com',
        placeholder: 'alerts@example.com',
      }),
    }),
    // The test sends a real message: a key that authenticates but cannot send
    // from this address is the failure people actually hit, and only a send
    // finds it.
    test: async (data: RawCredentialData) => {
      await sendEmail({ kind: 'resend', data }, [String(data['from'])], 'OpenWhale test', 'Alerting is configured.')
    },
  } as CredentialTypeDefinition,
  {
    ...notify({}),
    type: 'notify/ses',
    displayName: 'Amazon SES',
    logo: '/brands/amazon-ses.svg',
    icon: '📨',
    description: 'Email over Amazon SES v2. Needs ses:SendEmail on the sending identity.',
    documentationUrl: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html',
    schema: z.object({
      region: z.string().meta({ displayName: 'Region', placeholder: 'us-east-1' }),
      accessKeyId: z.string().meta({ displayName: 'Access Key ID' }),
      secretAccessKey: z.string().meta({ displayName: 'Secret Access Key' }),
      from: z.string().meta({
        displayName: 'From',
        description: 'A verified SES identity in that region.',
        placeholder: 'alerts@example.com',
      }),
    }),
    test: async (data: RawCredentialData) => {
      await sendEmail({ kind: 'ses', data }, [String(data['from'])], 'OpenWhale test', 'Alerting is configured.')
    },
  } as CredentialTypeDefinition,
  {
    ...notify({}),
    type: 'notify/smtp',
    displayName: 'SMTP server',
    logo: '/brands/smtp.svg',
    icon: '✉️',
    description: 'Any mail server of your own — host, port, and a login.',
    schema: z.object({
      host: z.string().meta({ displayName: 'Host', placeholder: 'smtp.example.com' }),
      port: z.coerce.number().int().min(1).max(65535).default(587).meta({ displayName: 'Port' }),
      secure: z.boolean().default(false).meta({
        displayName: 'Implicit TLS',
        description: 'On for port 465. Off for 587, which upgrades with STARTTLS.',
      }),
      user: z.string().optional().meta({ displayName: 'Username' }),
      password: z.string().optional().meta({ displayName: 'Password' }),
      from: z.string().meta({ displayName: 'From', placeholder: 'alerts@example.com' }),
    }),
    test: async (data: RawCredentialData) => {
      await sendEmail({ kind: 'smtp', data }, [String(data['from'])], 'OpenWhale test', 'Alerting is configured.')
    },
  } as CredentialTypeDefinition,
  {
    ...notify({}),
    type: 'notify/telegram',
    displayName: 'Telegram bot',
    logo: '/brands/telegram.svg',
    icon: '✈️',
    description: 'A bot token from @BotFather. The chat to send to is set on the Alerts page.',
    documentationUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    schema: z.object({
      botToken: z.string().meta({ displayName: 'Bot Token', placeholder: '123456:ABC-DEF…' }),
    }),
    // getMe, not sendMessage: a token can be valid while the bot has never been
    // spoken to, and there is no chat id here to send to anyway.
    test: async (data: RawCredentialData) => {
      const res = await fetch(`https://api.telegram.org/bot${String(data['botToken'])}/getMe`)
      const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string }
      if (!res.ok || body.ok !== true) throw new Error(body.description ?? `Telegram refused the token (HTTP ${res.status})`)
    },
  } as CredentialTypeDefinition,
]

export const NOTIFY_EMAIL_TYPES = ['notify/resend', 'notify/ses', 'notify/smtp'] as const
export const NOTIFY_TELEGRAM_TYPE = 'notify/telegram'

export function isEmailType(type: string): boolean {
  return (NOTIFY_EMAIL_TYPES as readonly string[]).includes(type)
}

/** Which transport a credential's type means, for the sender. */
export function emailKindOf(type: string): 'resend' | 'ses' | 'smtp' | undefined {
  return type === 'notify/resend' ? 'resend'
    : type === 'notify/ses' ? 'ses'
    : type === 'notify/smtp' ? 'smtp'
    : undefined
}

export { sendEmail, sendTelegram }
