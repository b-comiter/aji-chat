/**
 * Database provider — native (iOS / Android).
 *
 * Metro picks this file on native. Web uses DBProvider.web.tsx instead,
 * which has no expo-sqlite import and therefore no wa-sqlite.wasm dependency.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite'
import type { SQLiteDatabase } from 'expo-sqlite'
import { migrateDb } from './database'

const DBContext = createContext<SQLiteDatabase>(null as unknown as SQLiteDatabase)

export function useDB(): SQLiteDatabase {
  return useContext(DBContext)
}

/** Always rendered inside <SQLiteProvider>, so useSQLiteContext() is safe. */
function SQLiteDBBridge({ children }: { children: ReactNode }) {
  const db = useSQLiteContext()
  return <DBContext.Provider value={db}>{children}</DBContext.Provider>
}

export function DBProvider({ children }: { children: ReactNode }) {
  return (
    <SQLiteProvider databaseName="aji-chat.db" onInit={migrateDb}>
      <SQLiteDBBridge>{children}</SQLiteDBBridge>
    </SQLiteProvider>
  )
}
