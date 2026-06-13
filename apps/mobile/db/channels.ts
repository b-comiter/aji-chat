import type { SQLiteDatabase } from 'expo-sqlite'
import type { ChannelRow } from './schema'

/** Ensure a channel row exists, without disturbing an existing one. Like
 *  upsertServer, deliberately does NOT touch last_event_at on conflict — that
 *  reconnect churn made channels show "just now" with no new message. Genuine
 *  activity advances last_event_at only via updateChannelPreview.
 *  Caller MUST upsert the parent server row first (channels FK → servers). */
export async function upsertChannel(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO channels (server_id, channel_id, display_name, last_event_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, channel_id) DO NOTHING`,
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

/** The channel's last_read_at (unix ms) or null if never opened. Read BEFORE
 *  markChannelRead to capture the baseline for the "new messages" divider. */
export async function getChannelLastRead(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
): Promise<number | null> {
  const row = await db.getFirstAsync<{ last_read_at: number | null }>(
    `SELECT last_read_at FROM channels WHERE server_id = ? AND channel_id = ?`,
    serverId,
    channelId,
  )
  return row?.last_read_at ?? null
}

/** Mark a channel read up to now — clears its unread count. No-op for an unknown
 *  channel (does not bump last_event_at; opening shouldn't reorder the list). */
export async function markChannelRead(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE channels SET last_read_at = ? WHERE server_id = ? AND channel_id = ?`,
    Date.now(),
    serverId,
    channelId,
  )
}

/**
 * Unread message count per channel for a server: message/file items created
 * after each channel's last_read_at. Mirrors getUnreadCounts at the channel
 * grain. A never-read channel counts all its messages.
 */
export async function getUnreadChannelCounts(
  db: SQLiteDatabase,
  serverId: string,
): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ channel: string; n: number }>(
    `SELECT items.channel AS channel, COUNT(*) AS n
       FROM items
       JOIN channels ON channels.server_id = items.server_id AND channels.channel_id = items.channel
      WHERE items.server_id = ?
        AND items.kind IN ('message', 'file')
        AND items.created_at > COALESCE(channels.last_read_at, 0)
      GROUP BY items.channel`,
    serverId,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.channel] = r.n
  return out
}
