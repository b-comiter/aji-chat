/**
 * Theme context — provides the active color palette and lets users switch themes.
 *
 * Three preferences: 'auto' (follow OS), 'light', 'dark'.
 * The resolved palette switches immediately; the choice is persisted to SQLite.
 *
 * Must be rendered inside <DBProvider> so it can read/write the settings table.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useColorScheme } from 'react-native'
import { useDB } from '../db/DBProvider'
import { getSetting, setSetting } from '../db/database'
import {
  darkColors,
  lightColors,
  darkTokenColors,
  lightTokenColors,
  type ThemeColors,
} from '../constants/theme'

export type ThemePreference = 'auto' | 'light' | 'dark'

interface ThemeContextValue {
  colors: ThemeColors
  tokenColors: Record<string, string>
  themePreference: ThemePreference
  setThemePreference: (pref: ThemePreference) => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue>({
  colors: darkColors,
  tokenColors: darkTokenColors,
  themePreference: 'auto',
  setThemePreference: async () => {},
})

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const db = useDB()
  const systemScheme = useColorScheme() // 'light' | 'dark' | null
  const [preference, setPreferenceState] = useState<ThemePreference>('auto')

  // Load saved preference from the settings table on mount.
  // Falls back to 'auto' (system) while the async read is in flight — no flash
  // for the common case where the saved preference matches the system theme.
  useEffect(() => {
    getSetting(db, 'theme').then((saved) => {
      if (saved === 'light' || saved === 'dark' || saved === 'auto') {
        setPreferenceState(saved)
      }
    })
  }, [db])

  const setThemePreference = useCallback(async (pref: ThemePreference) => {
    setPreferenceState(pref)
    await setSetting(db, 'theme', pref)
  }, [db])

  // Resolve actual scheme: an explicit 'light'/'dark' choice wins outright;
  // 'auto' follows the OS (falling back to dark when the OS scheme is
  // unavailable, e.g. on older Android).
  const resolvedScheme: 'light' | 'dark' =
    preference === 'auto'
      ? (systemScheme === 'light' ? 'light' : 'dark')
      : preference

  const value = useMemo<ThemeContextValue>(() => ({
    colors:           resolvedScheme === 'light' ? lightColors : darkColors,
    tokenColors:      resolvedScheme === 'light' ? lightTokenColors : darkTokenColors,
    themePreference:  preference,
    setThemePreference,
  }), [resolvedScheme, preference, setThemePreference])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}
