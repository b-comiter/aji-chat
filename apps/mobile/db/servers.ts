import type { SQLiteDatabase } from 'expo-sqlite'
import { serverDisplayName, type ServerRow } from './schema'

/**
 * Ensure a server row exists, without disturbing an existing one. Deliberately
 * does NOT touch last_event_at on conflict: this runs for every event (status,
 * commands, channels, discovery), and agents re-broadcast those on each
 * reconnect — bumping last_event_at here made the list show "just now" and
 * reorder with no actual new message. Genuine activity advances last_event_at
 * only via updateServerPreview (message/file persists).
 */
export async function upsertServer(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO servers (id, display_name, last_event_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
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
  // Pinned rows float to the top (by pin slot); everything else by recency.
  return db.getAllAsync<ServerRow>(
    `SELECT * FROM servers
     ORDER BY (pin_position IS NULL), pin_position ASC, last_event_at DESC`,
  )
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

/** Mute (or unmute) a server's new-message sound. Ensures the row exists first. */
export async function setServerMuted(db: SQLiteDatabase, id: string, muted: boolean): Promise<void> {
  await upsertServer(db, id)
  await db.runAsync(`UPDATE servers SET muted = ? WHERE id = ?`, muted ? 1 : 0, id)
}

/**
 * Pin a server to the top, or unpin it (pinned = false). Pinned servers sort
 * above the rest in getAllServers. The pin slot is a negated timestamp so that,
 * under `pin_position ASC`, the most recently pinned server sorts first and
 * multiple pins keep a stable order with no renumbering — "single pin for now,
 * more later" needs no schema change.
 */
export async function setServerPinned(db: SQLiteDatabase, id: string, pinned: boolean): Promise<void> {
  await upsertServer(db, id)
  await db.runAsync(`UPDATE servers SET pin_position = ? WHERE id = ?`, pinned ? -Date.now() : null, id)
}

/**
 * Unread message count per server — the sum of its channels' unread (message/file
 * items created after each channel's last_read_at). Keyed on the items table (not
 * last_event_at) so it's stable across reconnects: replayed events are
 * `INSERT OR IGNORE`d and keep their original created_at, and status/touch churn
 * doesn't create items. A never-read channel (last_read_at NULL) counts all its
 * messages. See channels.markChannelRead for the read side.
 */
export async function getUnreadCounts(db: SQLiteDatabase): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ server_id: string; n: number }>(
    `SELECT items.server_id AS server_id, COUNT(*) AS n
       FROM items
       JOIN channels ON channels.server_id = items.server_id AND channels.channel_id = items.channel
      WHERE items.kind IN ('message', 'file')
        AND items.created_at > COALESCE(channels.last_read_at, 0)
      GROUP BY items.server_id`,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.server_id] = r.n
  return out
}

/**
 * Delete a server and all of its local data — message history, channels, and
 * cached commands — then the server row itself. Children are removed first
 * since they FK `servers(id)`. Local-only ("delete for me"): there's no
 * protocol verb to remove a server upstream; a live adapter that reconnects
 * simply re-creates its row.
 */
export async function deleteServer(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`DELETE FROM items WHERE server_id = ?`, id)
  await db.runAsync(`DELETE FROM channels WHERE server_id = ?`, id)
  await db.runAsync(`DELETE FROM command_cache WHERE server_id = ?`, id)
  await db.runAsync(`DELETE FROM servers WHERE id = ?`, id)
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
