/**
 * One clock for the whole dashboard.
 *
 * Times used to be formatted with the default zone, which is the BROWSER's on
 * the client and the SERVER's during SSR — and the server runs in UTC, so the
 * first paint of every table was eight hours out for a reader in Shanghai.
 * Worse, there was no way to ask for a zone: an operator reading a venue's
 * settlement times wants them in the venue's clock, not in the laptop's.
 *
 * So: one preference, kept in the `ow_tz` cookie (like `ow_locale`), read by
 * both sides of the render, and every time in the UI goes through the helpers
 * below. '' means the reader's own zone, whatever the browser says it is.
 */

export const TIME_ZONES: Array<{ id: string; label: string }> = [
  { id: '', label: 'System' },
  { id: 'UTC', label: 'UTC' },
  { id: 'Asia/Shanghai', label: 'Asia/Shanghai (UTC+8)' },
  { id: 'Asia/Tokyo', label: 'Asia/Tokyo (UTC+9)' },
  { id: 'Asia/Seoul', label: 'Asia/Seoul (UTC+9)' },
  { id: 'Asia/Singapore', label: 'Asia/Singapore (UTC+8)' },
  { id: 'Asia/Dubai', label: 'Asia/Dubai (UTC+4)' },
  { id: 'Europe/London', label: 'Europe/London' },
  { id: 'Europe/Berlin', label: 'Europe/Berlin' },
  { id: 'America/New_York', label: 'America/New_York' },
  { id: 'America/Chicago', label: 'America/Chicago' },
  { id: 'America/Los_Angeles', label: 'America/Los_Angeles' },
]

const COOKIE = 'ow_tz'

let zone: string | undefined

export function readTimeZoneCookie(): string {
  if (typeof document === 'undefined') return ''
  const m = /(?:^|;\s*)ow_tz=([^;]+)/.exec(document.cookie)
  return m?.[1] ? decodeURIComponent(m[1]) : ''
}

/** Set for this render — the layout calls it with the cookie's value on both sides. */
export function setActiveTimeZone(next: string): void {
  zone = next
}

export function activeTimeZone(): string {
  if (zone === undefined) zone = readTimeZoneCookie()
  return zone
}

/** The zone the reader actually sees, resolved: '' becomes the browser's own. */
export function resolvedTimeZone(): string {
  const z = activeTimeZone()
  if (z) return z
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
}

/** Switch zones: write the cookie and reload, so every rendered time changes at once. */
export function writeTimeZoneCookie(next: string): void {
  document.cookie = `${COOKIE}=${encodeURIComponent(next)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  setActiveTimeZone(next)
}

type TimeLike = number | string | Date

function date(v: TimeLike): Date {
  return v instanceof Date ? v : new Date(v)
}

function opts(extra: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const z = activeTimeZone()
  return z ? { ...extra, timeZone: z } : extra
}

/** 14:08:55 — the default for log lines and event feeds. */
export function fmtTime(v: TimeLike, extra: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }): string {
  return date(v).toLocaleTimeString(undefined, opts(extra))
}

/** 2026/9/13 14:08:55 — for tables where the day matters. */
export function fmtDateTime(v: TimeLike, extra: Intl.DateTimeFormatOptions = {}): string {
  return date(v).toLocaleString(undefined, opts(extra))
}

/**
 * 2026/9/13 14:08:55.123 — where the order of two rows in the same second is
 * the point, as in a fill list: the venue stamps fills to the millisecond and
 * a high-frequency account puts dozens inside one second.
 *
 * `fractionalSecondDigits` is formatted separately rather than passed to
 * toLocaleString: some locales drop it, and a timestamp that silently loses
 * its milliseconds is worse than one that never had them.
 */
export function fmtDateTimeMs(v: TimeLike): string {
  const d = date(v)
  const ms = Number.isNaN(d.getTime()) ? '000' : String(msIn(d)).padStart(3, '0')
  return `${fmtDateTime(d)}.${ms}`
}

/** Milliseconds as the ACTIVE zone sees them — whole-second offsets aside, the same. */
function msIn(d: Date): number {
  return d.getMilliseconds()
}

/** 2026/9/13 */
export function fmtDate(v: TimeLike, extra: Intl.DateTimeFormatOptions = {}): string {
  return date(v).toLocaleDateString(undefined, opts(extra))
}
