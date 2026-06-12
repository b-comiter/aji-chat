import type { SQLiteDatabase } from 'expo-sqlite'
import type { CommandItem } from '@aji/protocol'
import type { ServerRow } from './schema'
import { getAllServers } from './servers'

// ---------------------------------------------------------------------------
// History utilities
// ---------------------------------------------------------------------------

/**
 * Delete all items for one conversation. Pass a `channel` to clear just that
 * channel; omit it to clear every channel under the server. Keeps the server /
 * channel rows (preserves preview/status).
 */
export async function clearServerHistory(
  db: SQLiteDatabase,
  serverId: string,
  channel?: string,
): Promise<void> {
  if (channel === undefined) {
    await db.runAsync(`DELETE FROM items WHERE server_id = ?`, serverId)
  } else {
    await db.runAsync(`DELETE FROM items WHERE server_id = ? AND channel = ?`, serverId, channel)
  }
}

/** Delete every item, channel, and server row — full DB reset. */
export async function wipeAllHistory(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM items; DELETE FROM channels; DELETE FROM servers;`)
}

// ---------------------------------------------------------------------------
// Settings (key-value store)
// ---------------------------------------------------------------------------

export async function getSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    key,
  )
  return row?.value ?? null
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  )
}

// ---------------------------------------------------------------------------
// Command cache (per server)
// ---------------------------------------------------------------------------

export async function saveCachedCommands(
  db: SQLiteDatabase,
  serverId: string,
  commands: CommandItem[],
): Promise<void> {
  await db.runAsync(
    `INSERT INTO command_cache (server_id, commands, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       commands = excluded.commands,
       updated_at = excluded.updated_at`,
    serverId,
    JSON.stringify(commands),
    Date.now(),
  )
}

export async function loadCachedCommands(
  db: SQLiteDatabase,
  serverId: string,
): Promise<CommandItem[]> {
  const row = await db.getFirstAsync<{ commands: string }>(
    `SELECT commands FROM command_cache WHERE server_id = ? LIMIT 1`,
    serverId,
  )
  if (!row?.commands) return []
  try {
    const parsed = JSON.parse(row.commands) as CommandItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Debug dump (used by /view-db slash command)
// ---------------------------------------------------------------------------

export type DbDumpResult = {
  servers: ServerRow[]
  itemCounts: Record<string, { messages: number; tools: number; prompts: number }>
}

export async function getDbDump(db: SQLiteDatabase): Promise<DbDumpResult> {
  const servers = await getAllServers(db)
  const itemCounts: DbDumpResult['itemCounts'] = {}

  for (const server of servers) {
    const rows = await db.getAllAsync<{ kind: string; cnt: number }>(
      `SELECT kind, COUNT(*) as cnt FROM items WHERE server_id = ? GROUP BY kind`,
      server.id,
    )
    itemCounts[server.id] = { messages: 0, tools: 0, prompts: 0 }
    for (const row of rows) {
      if (row.kind === 'message') itemCounts[server.id].messages = row.cnt
      else if (row.kind === 'tool') itemCounts[server.id].tools = row.cnt
      else if (row.kind === 'prompt') itemCounts[server.id].prompts = row.cnt
    }
  }

  return { servers, itemCounts }
}
