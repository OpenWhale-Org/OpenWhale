import { describe, it, expect } from 'vitest'
import { resolveText, pickLocale, normalizeLocale, localize, foldLanguagePacks, isLocalizedText } from '../i18n.js'

describe('locales', () => {
  it('normalises the tag as people type it', () => {
    expect(normalizeLocale('zh_cn')).toBe('zh-CN')
    expect(normalizeLocale('ZH-CN')).toBe('zh-CN')
    expect(normalizeLocale('EN')).toBe('en')
  })

  it('picks the exact tag, then the language, then English, then the first', () => {
    expect(pickLocale(['en', 'zh-CN'], 'zh-CN')).toBe('zh-CN')
    expect(pickLocale(['en', 'zh-CN'], 'zh-TW')).toBe('zh-CN')
    expect(pickLocale(['en', 'zh-CN'], 'ja')).toBe('en')
    expect(pickLocale(['zh-CN'], 'ja')).toBe('zh-CN')
  })

  it('resolves a table and passes a string through', () => {
    expect(resolveText({ en: 'Notional', 'zh-CN': '名义仓位' }, 'zh-CN')).toBe('名义仓位')
    expect(resolveText({ en: 'Notional', 'zh-CN': '名义仓位' }, 'ja')).toBe('Notional')
    expect(resolveText('Notional', 'zh-CN')).toBe('Notional')
    expect(resolveText(undefined, 'zh-CN')).toBeUndefined()
  })

  it('a table needs `en` and only strings', () => {
    expect(isLocalizedText({ en: 'x', 'zh-CN': 'y' })).toBe(true)
    expect(isLocalizedText({ 'zh-CN': 'y' })).toBe(false)
    expect(isLocalizedText({ en: 'x', n: 1 })).toBe(false)
  })
})

describe('localize', () => {
  const def = {
    id: 'carry', name: { en: 'Carry', 'zh-CN': '套利' },
    paramsFields: [
      { name: 'legs', displayName: { en: 'The four legs', 'zh-CN': '四条腿' }, default: { en: 'not a text: a default' }, options: [{ value: 'a', label: { en: 'A', 'zh-CN': '甲' } }] },
    ],
    paramPresets: [{ id: 'p', label: 'Paper', base: { note: { en: 'a param value, kept' } } }],
  }
  it('resolves every table for the locale, deeply, and leaves data alone', () => {
    const zh = localize(def, 'zh-CN')
    expect(zh.name).toBe('套利')
    expect(zh.paramsFields[0]!.displayName).toBe('四条腿')
    expect(zh.paramsFields[0]!.options[0]!.label).toBe('甲')
    expect(zh.paramsFields[0]!.default).toEqual({ en: 'not a text: a default' })
    expect(zh.paramPresets[0]!.base).toEqual({ note: { en: 'a param value, kept' } })
    expect(localize(def, 'en').name).toBe('Carry')
  })
})

describe('language packs', () => {
  it('folds a pack into the definition, keeping the author\'s English', () => {
    const def = {
      id: 'carry', name: 'Carry', description: 'Locks a spread',
      paramsFields: [{ name: 'legs', displayName: 'The four legs', options: [{ value: 'a', label: 'A' }] }],
    }
    foldLanguagePacks(def, {
      'zh-CN': {
        'strategies.carry.name': '套利',
        'strategies.carry.params.legs.displayName': '四条腿',
        'strategies.carry.params.legs.options.a.label': '甲',
        'strategies.carry.params.nope.displayName': 'ignored — no such field',
        'monitors.other.name': 'not this prefix',
      },
    }, 'strategies.carry')
    expect(def.name).toEqual({ en: 'Carry', 'zh-CN': '套利' })
    expect(def.description).toBe('Locks a spread')
    expect(def.paramsFields[0]!.displayName).toEqual({ en: 'The four legs', 'zh-CN': '四条腿' })
    expect(def.paramsFields[0]!.options[0]!.label).toEqual({ en: 'A', 'zh-CN': '甲' })
    expect(localize(def, 'zh-CN').paramsFields[0]!.displayName).toBe('四条腿')
  })
})
