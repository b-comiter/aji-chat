import type { SQLiteDatabase } from 'expo-sqlite'
import { serverDisplayName, type ServerRow } from './schema'

/** Upsert a server row. Creates it if new; touches last_event_at otherwise. */
export async function upsertServer(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO servers (id, display_name, last_event_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_event_at = excluded.last_event_at`,
    id,
    serverDisplayName(id),
    Date.now(),
  )
}

export async function updateServerStatus(
  db: SQLiteDatabase,
  id: string,
  status: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO servers (id, display_name, last_status)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_status = excluded.last_status`,
    id,
    serverDisplayName(id),
    status,
  )
}

export async function updateServerPreview(
  db: SQLiteDatabase,
  id: string,
  preview: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE servers SET last_message_preview = ?, last_event_at = ? WHERE id = ?`,
    preview.slice(0, 120),
    Date.now(),
    id,
  )
}

export async function getAllServers(db: SQLiteDatabase): Promise<ServerRow[]> {
  return db.getAllAsync<ServerRow>(`SELECT * FROM servers ORDER BY last_event_at DESC`)
}

export async function getServer(db: SQLiteDatabase, id: string): Promise<ServerRow | null> {
  const row = await db.getFirstAsync<ServerRow>(`SELECT * FROM servers WHERE id = ? LIMIT 1`, id)
  return row ?? null
}

/** Set (or clear, with null) a server's avatar. Ensures the row exists first. */
export async function setServerAvatar(db: SQLiteDatabase, id: string, avatar: string | null): Promise<void> {
  await upsertServer(db, id)
  await db.runAsync(`UPDATE servers SET avatar = ? WHERE id = ?`, avatar, id)
}

/** Override a server's display name (user-set). Ensures the row exists first. */
export async function renameServer(db: SQLiteDatabase, id: string, name: string): Promise<void> {
  await upsertServer(db, id)
  await db.runAsync(`UPDATE servers SET display_name = ? WHERE id = ?`, name, id)
}

/** Set (or clear, with null) the user's local mono-channel override. */
export async function setServerMonoOverride(db: SQLiteDatabase, id: string, value: boolean | null): Promise<void> {
  await upsertServer(db, id)
  await db.runAsync(
    `UPDATE servers SET mono_channel_override = ? WHERE id = ?`,
    value === null ? null : value ? 1 : 0,
    id,
  )
}

/** Cache an adapter-advertised `server_info` (mono-channel default + name). */
export async function applyServerInfo(
  db: SQLiteDatabase,
  id: string,
  info: { monoChannel?: boolean; displayName?: string },
): Promise<void> {
  const existed = (await getServer(db, id)) !== null
  await upsertServer(db, id)
  if (info.monoChannel !== undefined) {
    await db.runAsync(`UPDATE servers SET mono_channel_advertised = ? WHERE id = ?`, info.monoChannel ? 1 : 0, id)
  }
  // Seed the advertised name only for a brand-new server. Never clobber an
  // existing row — otherwise a reconnect would silently revert a user's rename.
  if (info.displayName && !existed) {
    await db.runAsync(`UPDATE servers SET display_name = ? WHERE id = ?`, info.displayName, id)
  }
}
