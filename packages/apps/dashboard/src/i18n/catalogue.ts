/**
 * The merged catalogues.
 *
 * Strings are split by page under ./pages so that work on one page never
 * edits the file another page is being written in; the core catalogue in
 * ./en and ./zh-CN keeps the navigation, common words and the instances
 * pages that were translated first. Every key exists in English; a Chinese
 * catalogue is partial and falls back key by key.
 */
import { en as coreEn } from './en'
import { zhCN as coreZh } from './zh-CN'
import * as plugins from './pages/plugins'
import * as monitor from './pages/monitor'
import * as compiler from './pages/compiler'
import * as accounts from './pages/accounts'
import * as onboarding from './pages/onboarding'
import * as records from './pages/records'

export const en = {
  ...coreEn,
  ...plugins.en,
  ...monitor.en,
  ...compiler.en,
  ...accounts.en,
  ...onboarding.en,
  ...records.en,
}

export type MessageKey = keyof typeof en

export const zhCN: Partial<Record<MessageKey, string>> = {
  ...coreZh,
  ...plugins.zhCN,
  ...monitor.zhCN,
  ...compiler.zhCN,
  ...accounts.zhCN,
  ...onboarding.zhCN,
  ...records.zhCN,
}

/** Replace `{name}` in a message with the values given. */
export function fill(message: string, values?: Record<string, string | number>): string {
  if (!values) return message
  return message.replace(/\{(\w+)\}/g, (_, k: string) => (values[k] !== undefined ? String(values[k]) : `{${k}}`))
}

export type Locale = 'en' | 'zh-CN'

export function translator(locale: Locale): (key: MessageKey, values?: Record<string, string | number>) => string {
  const table = locale === 'zh-CN' ? zhCN : {}
  return (key, values) => fill(table[key] ?? en[key], values)
}
