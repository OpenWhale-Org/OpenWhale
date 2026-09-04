/**
 * Text in more than one language, and the one place it is resolved.
 *
 * A strategy names its params for a person; the person may read Chinese.
 * Every user-facing string a plugin declares — a name, a param's label, a
 * hint, a section, a README — may be a plain string (taken as English) or a
 * table keyed by locale with `en` required. The runtime keeps the tables as
 * declared and the gateway resolves them once per request for the locale
 * the reader asked for, so a plugin is translated by adding entries, never by
 * forking code, and a Dashboard never sees a table.
 *
 * Plugins that would rather keep their source monolingual ship a language
 * pack instead: a flat map of dotted paths to strings, folded into the same
 * tables at load. An operator can lay a pack over a plugin they did not
 * write, from the data directory, the same way.
 */

/** A BCP-47 tag as commonly written: 'en', 'zh-CN', 'ja'. */
export type Locale = string

export const DEFAULT_LOCALE: Locale = 'en'

/** A string in several languages. `en` is required: it is what every other locale falls back to. */
export type LocalizedText = { en: string } & Record<string, string>

/** What a plugin may write wherever a person will read it. */
export type Text = string | LocalizedText

/** The same shape with every Text resolved to a string — what a reader is sent. */
export type Localized<T> =
  T extends string ? string
    : T extends LocalizedText ? string
      : T extends (infer U)[] ? Localized<U>[]
        : T extends (...args: never[]) => unknown ? T
          : T extends object ? { [K in keyof T]: Localized<T[K]> }
            : T

/** A pack: dotted path → string, for one locale. `strategies.carry.params.legs.displayName`. */
export type LanguagePack = Record<string, string>

export function isLocalizedText(value: unknown): value is LocalizedText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record['en'] !== 'string') return false
  return Object.values(record).every(v => typeof v === 'string')
}

/** 'zh_cn' / 'zh-cn' / 'ZH-CN' → 'zh-CN'; 'EN' → 'en'. */
export function normalizeLocale(raw: string): Locale {
  const [lang = '', ...rest] = raw.trim().replace(/_/g, '-').split('-')
  const region = rest.join('-')
  return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase()
}

/**
 * Which of the available locales serves `wanted`: the exact tag, then the
 * same language in any region, then English, then whatever is first.
 */
export function pickLocale(available: readonly Locale[], wanted: Locale): Locale | undefined {
  if (available.length === 0) return undefined
  const want = normalizeLocale(wanted)
  const exact = available.find(l => normalizeLocale(l) === want)
  if (exact) return exact
  const lang = want.split('-')[0]
  const sameLanguage = available.find(l => normalizeLocale(l).split('-')[0] === lang)
  if (sameLanguage) return sameLanguage
  return available.find(l => normalizeLocale(l) === DEFAULT_LOCALE) ?? available[0]
}

export function resolveText(text: Text, locale?: Locale): string
export function resolveText(text: Text | undefined, locale?: Locale): string | undefined
export function resolveText(text: Text | undefined, locale: Locale = DEFAULT_LOCALE): string | undefined {
  if (text === undefined || typeof text === 'string') return text
  const key = pickLocale(Object.keys(text), locale)
  return key === undefined ? text.en : text[key]
}

/**
 * Keys under which a definition carries DATA, not text: a param's default,
 * an option's value, a preset's params. A table-shaped value there is the
 * operator's, and stays as it is.
 */
const OPAQUE_KEYS = new Set(['default', 'value', 'base', 'tunable', 'data', 'params', 'config', 'schema', 'html'])

/**
 * The definition with every Text resolved for `locale`, deeply. Arrays and
 * plain objects are walked; class instances, functions and the opaque keys
 * above are passed through untouched.
 */
export function localize<T>(value: T, locale: Locale = DEFAULT_LOCALE): Localized<T> {
  return walk(value, locale) as Localized<T>
}

function walk(value: unknown, locale: Locale): unknown {
  if (value === null || typeof value !== 'object') return value
  if (isLocalizedText(value)) return resolveText(value, locale)
  if (Array.isArray(value)) return value.map(v => walk(v, locale))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value   // a class instance: not a definition
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = OPAQUE_KEYS.has(k) ? v : walk(v, locale)
  }
  return out
}

/**
 * Fold language packs into a definition.
 *
 * For every pack entry under `prefix` the addressed field becomes a table:
 * a plain string there is kept as `en`, a table gains the locale. A path
 * walks objects by key and arrays by an element's `name`, `value` or `id`
 * — `params.legs.displayName`, `params.side.options.buy.label`. A path
 * that leads nowhere is skipped, so a pack written against a newer or older
 * plugin degrades to silence rather than an error at load.
 */
export function foldLanguagePacks<T extends object>(target: T, packs: Record<Locale, LanguagePack> | undefined, prefix: string): T {
  if (!packs) return target
  const head = prefix ? `${prefix}.` : ''
  for (const [locale, pack] of Object.entries(packs)) {
    for (const [path, translated] of Object.entries(pack)) {
      if (!path.startsWith(head)) continue
      setText(target as Record<string, unknown>, path.slice(head.length).split('.'), normalizeLocale(locale), translated)
    }
  }
  return target
}

function setText(node: unknown, segments: string[], locale: Locale, translated: string): void {
  if (!node || typeof node !== 'object') return
  const [seg, ...rest] = segments
  if (seg === undefined) return
  if (Array.isArray(node)) {
    const hit = node.find(el => el && typeof el === 'object' && ['name', 'value', 'id'].some(k => String((el as Record<string, unknown>)[k]) === seg))
    return setText(hit, [ ...(rest.length ? rest : []) ], locale, translated) // eslint-disable-line @typescript-eslint/no-unsafe-return
  }
  const record = node as Record<string, unknown>
  if (rest.length === 0) {
    const current = record[seg]
    if (current === undefined && locale !== DEFAULT_LOCALE) return   // nothing to translate: the field is not there
    if (typeof current === 'string') record[seg] = { en: current, [locale]: translated }
    else if (isLocalizedText(current)) record[seg] = { ...current, [locale]: translated }
    else if (current === undefined) record[seg] = { en: translated }
    return
  }
  // 'params' addresses the derived fields; the rest is what the author wrote.
  const next = seg === 'params' && Array.isArray(record['paramsFields']) ? record['paramsFields'] : record[seg]
  setText(next, rest, locale, translated)
}
