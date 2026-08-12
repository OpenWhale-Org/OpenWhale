export type UiMode = 'classic' | 'aurora'

export const UI_MODE_COOKIE = 'openwhale-ui'

export function parseUiMode(value: string | undefined): UiMode {
  return value === 'aurora' ? 'aurora' : 'classic'
}
