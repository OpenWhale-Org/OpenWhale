'use client'

/**
 * The Dashboard's own language.
 *
 * One locale for the whole page, chosen once and kept in the `ow_locale`
 * cookie — the same cookie the gateway reads, so a strategy's labels arrive
 * in the language the chrome is drawn in. Switching writes the cookie and
 * reloads: every page fetches its definitions on mount, and a reload is the
 * one way to be sure nothing is left in the old language.
 *
 * Strings live in ./en and ./zh-CN, keyed; `t('key')` reads the current one,
 * and a key missing from a catalogue falls back to English rather than to
 * the key, so an untranslated string is still a sentence.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { en, zhCN, fill, type Locale, type MessageKey } from './catalogue'

export type { Locale, MessageKey }

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '中文' },
]

const CATALOGS: Record<Locale, Partial<Record<MessageKey, string>>> = { en, 'zh-CN': zhCN }

export function readLocaleCookie(): Locale {
  if (typeof document === 'undefined') return 'en'
  const m = /(?:^|;\s*)ow_locale=([^;]+)/.exec(document.cookie)
  const raw = m?.[1] ? decodeURIComponent(m[1]) : ''
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `ow_locale=${encodeURIComponent(locale)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
}

interface I18n {
  locale: Locale
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18n>({
  locale: 'en',
  t: (key, values) => fill(en[key], values),
  setLocale: () => {},
})

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18n>(() => ({
    locale,
    t: (key, values) => fill(CATALOGS[locale][key] ?? en[key], values),
    setLocale: (next) => {
      writeLocaleCookie(next)
      window.location.reload()
    },
  }), [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}

export function useT(): I18n['t'] {
  return useContext(I18nContext).t
}
