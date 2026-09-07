import crypto from 'crypto'
import type { RawCredentialData } from '@openwhaleorg/core'

/**
 * Delivery. Three ways to send an email and one to send a Telegram message,
 * behind one call each.
 *
 * Every one of them throws on failure with the provider's own words. An alert
 * that fails silently is worse than no alerting at all: it converts "I would
 * have been told" into a belief, and the belief is what the operator acts on.
 */

export type EmailTransport =
  | { kind: 'resend'; data: RawCredentialData }
  | { kind: 'ses'; data: RawCredentialData }
  | { kind: 'smtp'; data: RawCredentialData }

const str = (d: RawCredentialData, k: string): string => String(d[k] ?? '')

/** Ten seconds: an alert that has not left in ten seconds is not an alert. */
const TIMEOUT_MS = 10_000

async function postJson(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

export async function sendEmail(transport: EmailTransport, to: string[], subject: string, text: string): Promise<void> {
  if (to.length === 0) throw new Error('No recipients')
  if (transport.kind === 'resend') return sendResend(transport.data, to, subject, text)
  if (transport.kind === 'ses') return sendSes(transport.data, to, subject, text)
  return sendSmtp(transport.data, to, subject, text)
}

/* ── Resend ─────────────────────────────────────────────────────────────────*/

async function sendResend(data: RawCredentialData, to: string[], subject: string, text: string): Promise<void> {
  const res = await postJson(
    'https://api.resend.com/emails',
    { Authorization: `Bearer ${str(data, 'apiKey')}`, 'Content-Type': 'application/json' },
    JSON.stringify({ from: str(data, 'from'), to, subject, text }),
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resend refused the message (HTTP ${res.status})${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
}

/* ── Amazon SES v2 ──────────────────────────────────────────────────────────
 *
 * Signed by hand rather than through the AWS SDK. The SDK is tens of megabytes
 * of client for one POST, and SigV4 is a hash chain: four HMACs to derive the
 * key, one to sign a canonical request. The whole of it is below.
 */

const sha256 = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex')
const hmac = (key: string | Buffer, s: string): Buffer => crypto.createHmac('sha256', key).update(s).digest()

async function sendSes(data: RawCredentialData, to: string[], subject: string, text: string): Promise<void> {
  const region = str(data, 'region')
  const host = `email.${region}.amazonaws.com`
  const path = '/v2/email/outbound-emails'
  const payload = JSON.stringify({
    FromEmailAddress: str(data, 'from'),
    Destination: { ToAddresses: to },
    Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
  })

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')   // 20260830T101500Z
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${region}/ses/aws4_request`

  // Canonical request: the exact bytes AWS will hash on its side. Header names
  // lowercased and sorted, values trimmed — any drift here reads as a bad key.
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'content-type;host;x-amz-date'
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${str(data, 'secretAccessKey')}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 'ses')
  const signature = crypto.createHmac('sha256', hmac(kService, 'aws4_request')).update(toSign).digest('hex')

  const res = await postJson(`https://${host}${path}`, {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${str(data, 'accessKeyId')}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }, payload)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SES refused the message (HTTP ${res.status})${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
}

/* ── A mail server of your own ──────────────────────────────────────────────*/

async function sendSmtp(data: RawCredentialData, to: string[], subject: string, text: string): Promise<void> {
  // Imported here rather than at module load: a gateway that alerts through
  // Resend should not pay for a mail library it never calls.
  const { createTransport } = await import('nodemailer')
  const user = str(data, 'user')
  const transport = createTransport({
    host: str(data, 'host'),
    port: Number(data['port'] ?? 587),
    secure: data['secure'] === true,
    ...(user ? { auth: { user, pass: str(data, 'password') } } : {}),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })
  try {
    await transport.sendMail({ from: str(data, 'from'), to: to.join(', '), subject, text })
  } finally {
    transport.close()
  }
}

/* ── Telegram ───────────────────────────────────────────────────────────────*/

export async function sendTelegram(data: RawCredentialData, chatId: string, text: string): Promise<void> {
  if (!chatId) throw new Error('No chat id')
  const res = await postJson(
    `https://api.telegram.org/bot${str(data, 'botToken')}/sendMessage`,
    { 'Content-Type': 'application/json' },
    // No parse mode: an error message is arbitrary text, and a stray underscore
    // in a symbol would make Telegram reject the whole alert as bad Markdown.
    JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  )
  const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string }
  if (!res.ok || body.ok !== true) {
    throw new Error(body.description ?? `Telegram refused the message (HTTP ${res.status})`)
  }
}
