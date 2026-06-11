import type { SQLiteDatabase } from 'expo-sqlite'
import type { ChannelRow } from './schema'

/** Upsert a channel row. Creates it if new; touches last_event_at otherwise.
 *  Caller MUST upsert the parent server row first (channels FK → servers). */
export async function upsertChannel(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO channels (server_id, channel_id, display_name, last_event_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, channel_id) DO UPDATE SET last_event_at = excluded.last_event_at`,
    serverId,
    channelId,
    channelId,
    Date.now(),
  )
}

export async function updateChannelStatus(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
  status: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO channels (server_id, channel_id, display_name, last_status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, channel_id) DO UPDATE SET last_status = excluded.last_status`,
    serverId,
    channelId,
    channelId,
    status,
  )
}

export async function updateChannelPreview(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
  preview: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE channels SET last_message_preview = ?, last_event_at = ?
     WHERE server_id = ? AND channel_id = ?`,
    preview.slice(0, 120),
    Date.now(),
    serverId,
    channelId,
  )
}

/**
 * All channels for a server, ordered by the user's manual `position` first and
 * recency as the tiebreak. Channels never reordered share `position = 0`, so the
 * default experience stays "most-recently-active first" until the user drags.
 */
export async function getChannelsForServer(
  db: SQLiteDatabase,
  serverId: string,
): Promise<ChannelRow[]> {
  return db.getAllAsync<ChannelRow>(
    `SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, last_event_at DESC`,
    serverId,
  )
}

/**
 * Persist a user-defined channel order. `orderedChannelIds` is the full channel
 * list in display order; each channel's `position` is set to its index. Runs in
 * a transaction so the list never reads back half-updated.
 */
export async function setChannelOrder(
  db: SQLiteDatabase,
  serverId: string,
  orderedChannelIds: string[],
): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < orderedChannelIds.length; i++) {
      await db.runAsync(
        `UPDATE channels SET position = ? WHERE server_id = ? AND channel_id = ?`,
        i,
        serverId,
        orderedChannelIds[i],
      )
    }
  })
}

/**
 * Delete a single channel and its local message history. Items first (FK),
 * then the channel row. The server row is left intact.
 */
export async function deleteChannel(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
): Promise<void> {
  await db.runAsync(`DELETE FROM items WHERE server_id = ? AND channel = ?`, serverId, channelId)
  await db.runAsync(`DELETE FROM channels WHERE server_id = ? AND channel_id = ?`, serverId, channelId)
}
