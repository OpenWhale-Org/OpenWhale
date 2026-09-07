/**
 * The same catalogue, for server components.
 *
 * A page.tsx that renders a heading before any client code runs cannot read
 * the context; it reads the cookie the layout reads and translates with the
 * same tables. `await serverT()` then `t('key')`.
 */
import { cookies } from 'next/headers'
import { translator, type Locale, type MessageKey } from './catalogue'

export async function serverLocale(): Promise<Locale> {
  const store = await cookies()
  return (store.get('ow_locale')?.value ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export async function serverT(): Promise<(key: MessageKey, values?: Record<string, string | number>) => string> {
  return translator(await serverLocale())
}
