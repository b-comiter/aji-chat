/**
 * Database provider — web (browser / dev).
 *
 * Metro picks this file instead of DBProvider.tsx when bundling for web.
 * expo-sqlite is NOT imported here (not even as a type) so Metro never
 * attempts to resolve wa-sqlite.wasm in the web bundle.
 *
 * All DB operations are silent no-ops. Persistence is skipped on web, which
 * is acceptable because the browser target is development-only.
 */
import { createContext, useContext, type ReactNode } from 'react'

// Minimal shape matching the expo-sqlite methods used throughout the app.
// Defined locally so this file has zero dependency on expo-sqlite.
type DB = {
  execAsync(source: string): Promise<void>
  runAsync(source: string, ...params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>
  getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]>
  getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null>
}

const noopDB: DB = {
  execAsync: async () => {},
  runAsync: async () => ({ lastInsertRowId: 0, changes: 0 }),
  getAllAsync: async <T,>(): Promise<T[]> => [],
  getFirstAsync: async <T,>(): Promise<T | null> => null,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DBContext = createContext<DB>(noopDB)

export function useDB(): DB {
  return useContext(DBContext)
}

export function DBProvider({ children }: { children: ReactNode }) {
  return <DBContext.Provider value={noopDB}>{children}</DBContext.Provider>
}
