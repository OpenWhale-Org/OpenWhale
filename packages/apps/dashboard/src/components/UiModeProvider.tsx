'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { UI_MODE_COOKIE, type UiMode } from '@/lib/ui-mode'

interface UiModeContextValue {
  mode: UiMode
  setMode: (mode: UiMode) => void
  toggleMode: () => void
}

const UiModeContext = createContext<UiModeContextValue | null>(null)

export function UiModeProvider({ initialMode, children }: { initialMode: UiMode; children: React.ReactNode }) {
  const [mode, setModeState] = useState<UiMode>(initialMode)

  const setMode = useCallback((next: UiMode) => {
    setModeState(next)
    document.cookie = `${UI_MODE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
  }, [])

  const value = useMemo<UiModeContextValue>(() => ({
    mode,
    setMode,
    toggleMode: () => setMode(mode === 'classic' ? 'aurora' : 'classic'),
  }), [mode, setMode])

  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>
}

export function useUiMode(): UiModeContextValue {
  const value = useContext(UiModeContext)
  if (!value) throw new Error('useUiMode must be used inside UiModeProvider')
  return value
}
