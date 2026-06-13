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
  ajiDarkColors,
  ajiLightColors,
  darkTokenColors,
  lightTokenColors,
  type ThemeColors,
} from '../constants/theme'

export type ThemePreference = 'auto' | 'light' | 'dark'

/** Color family (palette), independent of the light/dark mode preference.
 *  'aji' = premium navy + gold; 'classic' = the original GitHub-inspired set. */
export type PaletteFamily = 'aji' | 'classic'

/** Maps a palette family + resolved light/dark scheme to a concrete palette. */
const PALETTES: Record<PaletteFamily, { light: ThemeColors; dark: ThemeColors }> = {
  aji:     { light: ajiLightColors, dark: ajiDarkColors },
  classic: { light: lightColors,    dark: darkColors },
}

interface ThemeContextValue {
  colors: ThemeColors
  tokenColors: Record<string, string>
  themePreference: ThemePreference
  setThemePreference: (pref: ThemePreference) => Promise<void>
  paletteFamily: PaletteFamily
  setPaletteFamily: (family: PaletteFamily) => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue>({
  colors: ajiDarkColors,
  tokenColors: darkTokenColors,
  themePreference: 'auto',
  setThemePreference: async () => {},
  paletteFamily: 'aji',
  setPaletteFamily: async () => {},
})

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const db = useDB()
  const systemScheme = useColorScheme() // 'light' | 'dark' | null
  const [preference, setPreferenceState] = useState<ThemePreference>('auto')
  const [palette, setPaletteState] = useState<PaletteFamily>('aji')

  // Load saved preferences from the settings table on mount.
  // Falls back to defaults ('auto' mode, 'aji' palette) while the async read is
  // in flight — no flash for the common case where saved values match defaults.
  useEffect(() => {
    getSetting(db, 'theme').then((saved) => {
      if (saved === 'light' || saved === 'dark' || saved === 'auto') {
        setPreferenceState(saved)
      }
    })
    getSetting(db, 'palette').then((saved) => {
      if (saved === 'aji' || saved === 'classic') {
        setPaletteState(saved)
      }
    })
  }, [db])

  const setThemePreference = useCallback(async (pref: ThemePreference) => {
    setPreferenceState(pref)
    await setSetting(db, 'theme', pref)
  }, [db])

  const setPaletteFamily = useCallback(async (family: PaletteFamily) => {
    setPaletteState(family)
    await setSetting(db, 'palette', family)
  }, [db])

  // Resolve actual scheme: an explicit 'light'/'dark' choice wins outright;
  // 'auto' follows the OS (falling back to dark when the OS scheme is
  // unavailable, e.g. on older Android).
  const resolvedScheme: 'light' | 'dark' =
    preference === 'auto'
      ? (systemScheme === 'light' ? 'light' : 'dark')
      : preference

  const value = useMemo<ThemeContextValue>(() => ({
    colors:           PALETTES[palette][resolvedScheme],
    tokenColors:      resolvedScheme === 'light' ? lightTokenColors : darkTokenColors,
    themePreference:  preference,
    setThemePreference,
    paletteFamily:    palette,
    setPaletteFamily,
  }), [resolvedScheme, palette, preference, setThemePreference, setPaletteFamily])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}
