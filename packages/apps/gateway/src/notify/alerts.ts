import { getLogger, type ExecutionResult, type OpenWhaleRuntime, type CredentialStore } from '@openwhaleorg/core'
import type { SQLiteAdapter } from '@openwhaleorg/core'
import { emailKindOf, sendEmail, sendTelegram } from './credentialTypes.js'

const log = () => getLogger().child({ module: 'Alerts' })

/**
 * Who gets told when an execution goes wrong.
 *
 * One configuration for the engine rather than one per login: a gateway is run
 * by an operator or a small team who all want the same page, and splitting the
 * destination per user would make "did anyone get told" a question with as
 * many answers as there are accounts.
 */
export interface AlertSettings {
  enabled: boolean
  /** Credential name of a notify/resend | notify/ses | notify/smtp key. */
  emailCredential?: string
  emailTo: string[]
  /** Credential name of a notify/telegram key. */
  telegramCredential?: string
  telegramChatId?: string
}

export const DEFAULT_SETTINGS: AlertSettings = { enabled: false, emailTo: [] }

/** Identical alerts inside this window are sent once. */
const DEDUPE_MS = 15 * 60_000
/** Most alerts one instance may send in a rolling hour. */
const HOURLY_CAP = 20
const HOUR_MS = 60 * 60_000

interface Row { [k: string]: unknown; payload: string }

export class AlertService {
  private settings: AlertSettings = DEFAULT_SETTINGS
  /** dedupe key → when it was last sent. */
  private readonly lastSent = new Map<string, number>()
  /** instanceId → the timestamps of what it sent this hour. */
  private readonly recent = new Map<string, number[]>()
  /** instanceId → how many were dropped for the cap since the last one got through. */
  private readonly suppressed = new Map<string, number>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly db: SQLiteAdapter,
    private readonly runtime: OpenWhaleRuntime,
    private readonly credentials: CredentialStore,
  ) {}

  async initialize(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_settings (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        payload    TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.settings = await this.load()
    this.unsubscribe?.()
    this.unsubscribe = this.runtime.onExecution((result) => { void this.consider(result) })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async load(): Promise<AlertSettings> {
    const row = await this.db.get<Row>('SELECT payload FROM alert_settings WHERE id = 1')
    if (!row) return DEFAULT_SETTINGS
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.payload) as Partial<AlertSettings>) }
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  async save(next: AlertSettings): Promise<AlertSettings> {
    const clean: AlertSettings = {
      enabled: next.enabled === true,
      emailTo: (next.emailTo ?? []).map(s => s.trim()).filter(Boolean),
      ...(next.emailCredential ? { emailCredential: next.emailCredential } : {}),
      ...(next.telegramCredential ? { telegramCredential: next.telegramCredential } : {}),
      ...(next.telegramChatId ? { telegramChatId: next.telegramChatId.trim() } : {}),
    }
    await this.db.run(
      `INSERT INTO alert_settings (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [JSON.stringify(clean), new Date().toISOString()],
    )
    this.settings = clean
    return clean
  }

  current(): AlertSettings {
    return this.settings
  }

  /**
   * Does this execution deserve an alert, and may it have one?
   *
   * Never throws: this runs off the execution path, and an alerting fault must
   * not be able to disturb the thing it is reporting on.
   */
  private async consider(result: ExecutionResult): Promise<void> {
    try {
      // A held-back instruction is not an event: nothing was attempted, so
      // there is nothing to warn about and nothing to confirm.
      if (result.status === 'dry-run') return
      if (!this.settings.enabled) return
      const instanceId = result.instruction.instanceId
      if (!instanceId) return

      const instance = (await this.runtime.listInstanceViews()).find(v => v.id === instanceId)
      if (!instance) return
      const options = instance.options ?? {}
      const action = result.instruction.action

      const failed = result.status === 'failed'
      // Absent means on: an operator who has never opened the panel still wants
      // to hear that their strategy is failing.
      const wantsFailure = failed && options.alertOnFailure !== false
      const wantsAction = (options.alertOnActions ?? []).includes(action)
      if (!wantsFailure && !wantsAction) return

      const key = `${instanceId}:${result.instruction.executorId}:${action}:${failed ? result.error ?? '' : 'ok'}`
      const now = Date.now()
      const last = this.lastSent.get(key)
      if (last !== undefined && now - last < DEDUPE_MS) return

      const window = (this.recent.get(instanceId) ?? []).filter(t => now - t < HOUR_MS)
      if (window.length >= HOURLY_CAP) {
        this.suppressed.set(instanceId, (this.suppressed.get(instanceId) ?? 0) + 1)
        this.recent.set(instanceId, window)
        return
      }
      window.push(now)
      this.recent.set(instanceId, window)
      this.lastSent.set(key, now)

      const held = this.suppressed.get(instanceId) ?? 0
      this.suppressed.delete(instanceId)

      const subject = failed
        ? `OpenWhale: ${instance.name} — ${action} failed`
        : `OpenWhale: ${instance.name} — ${action}`
      await this.dispatch(subject, this.body(result, instance.name, held))
    } catch (err) {
      log().warn({ err }, 'Alert check failed — ignored')
    }
  }

  private body(result: ExecutionResult, instanceName: string, suppressed: number): string {
    const i = result.instruction
    const lines = [
      `Instance:  ${instanceName}`,
      `Executor:  ${i.executorId}`,
      `Action:    ${i.action}`,
      `Status:    ${result.status}`,
      `At:        ${new Date(result.executedAt).toISOString()}`,
    ]
    if (result.error) lines.push('', `Error:     ${result.error}`)
    // The params are what makes the alert actionable rather than merely
    // alarming: "placeOrder failed" is a page, "placeOrder BTC 5000 USD failed"
    // is a decision. Bounded, because an alert is not a log.
    const params = JSON.stringify(i.params ?? {})
    lines.push('', `Params:    ${params.length > 800 ? `${params.slice(0, 800)}…` : params}`)
    if (suppressed > 0) {
      lines.push('', `(${suppressed} further alert${suppressed === 1 ? '' : 's'} from this instance were suppressed by the hourly cap.)`)
    }
    return lines.join('\n')
  }

  /**
   * Send on every configured channel. Each is attempted independently: a
   * Telegram bot that has been kicked from its group must not take the email
   * down with it.
   */
  async dispatch(subject: string, text: string): Promise<{ sent: string[]; failed: Array<{ channel: string; error: string }> }> {
    const sent: string[] = []
    const failed: Array<{ channel: string; error: string }> = []
    const s = this.settings

    if (s.emailCredential && s.emailTo.length > 0) {
      try {
        const cred = await this.credentials.getByName(s.emailCredential)
        const kind = emailKindOf(cred.type)
        if (!kind) throw new Error(`"${s.emailCredential}" is a ${cred.type}, not an email credential`)
        await sendEmail({ kind, data: cred.data }, s.emailTo, subject, text)
        sent.push('email')
      } catch (err) {
        failed.push({ channel: 'email', error: err instanceof Error ? err.message : String(err) })
      }
    }

    if (s.telegramCredential && s.telegramChatId) {
      try {
        const cred = await this.credentials.getByName(s.telegramCredential)
        await sendTelegram(cred.data, s.telegramChatId, `${subject}\n\n${text}`)
        sent.push('telegram')
      } catch (err) {
        failed.push({ channel: 'telegram', error: err instanceof Error ? err.message : String(err) })
      }
    }

    for (const f of failed) log().warn({ channel: f.channel, error: f.error }, 'Alert channel failed')
    return { sent, failed }
  }
}

let service: AlertService | null = null

export function setAlertService(s: AlertService): void {
  service = s
}

export function getAlertService(): AlertService | null {
  return service
}
