import type { SQLiteDatabase } from 'expo-sqlite'
import type { ChannelRow } from './schema'

/** Ensure a channel row exists, without disturbing an existing one. Like
 *  upsertServer, deliberately does NOT touch last_event_at on conflict — that
 *  reconnect churn made channels show "just now" with no new message. Genuine
 *  activity advances last_event_at only via updateChannelPreview.
 *  Caller MUST upsert the parent server row first (channels FK → servers).
 *  When displayName is provided it is applied even if the row already exists —
 *  used by the Desktop hook to stamp the auto-generated conversation title. */
export async function upsertChannel(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
  displayName?: string,
  cwd?: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO channels (server_id, channel_id, display_name, last_event_at, cwd)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(server_id, channel_id) DO NOTHING`,
    serverId,
    channelId,
    displayName ?? channelId,
    Date.now(),
    cwd ?? null,
  )
  if (displayName !== undefined) {
    await db.runAsync(
      `UPDATE channels SET display_name = ? WHERE server_id = ? AND channel_id = ?`,
      displayName,
      serverId,
      channelId,
    )
  }
  // Only overwrite cwd when a non-empty one is supplied, so a later event without
  // it (e.g. an auto-discovery upsert) doesn't wipe the registered directory.
  if (cwd) {
    await db.runAsync(
      `UPDATE channels SET cwd = ? WHERE server_id = ? AND channel_id = ?`,
      cwd,
      serverId,
      channelId,
    )
  }
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
 * All channels for a server. Live channels first; archived ones (their backing
 * terminal is gone) sink to the bottom. Within each group, the user's manual
 * `position` leads with recency as the tiebreak. Channels never reordered share
 * `position = 0`, so the default experience stays "most-recently-active first".
 */
export async function getChannelsForServer(
  db: SQLiteDatabase,
  serverId: string,
): Promise<ChannelRow[]> {
  return db.getAllAsync<ChannelRow>(
    `SELECT * FROM channels WHERE server_id = ? ORDER BY archived ASC, position ASC, last_event_at DESC`,
    serverId,
  )
}

/**
 * Reconcile archived state from a `sessions` event's live-channel set. A channel
 * present in `liveChannels` is un-archived; a known channel absent from it is
 * archived ONLY if it has prior activity (`last_event_at` set) — a brand-new,
 * never-messaged channel is left live so it isn't archived before its terminal
 * has had a chance to boot. Runs in a transaction so the list never reads back
 * half-updated.
 */
export async function reconcileArchivedSessions(
  db: SQLiteDatabase,
  serverId: string,
  liveChannels: string[],
): Promise<void> {
  const live = new Set(liveChannels)
  const rows = await db.getAllAsync<{ channel_id: string; last_event_at: number | null }>(
    `SELECT channel_id, last_event_at FROM channels WHERE server_id = ?`,
    serverId,
  )
  await db.withTransactionAsync(async () => {
    for (const r of rows) {
      const archived = !live.has(r.channel_id) && r.last_event_at != null ? 1 : 0
      await db.runAsync(
        `UPDATE channels SET archived = ? WHERE server_id = ? AND channel_id = ?`,
        archived,
        serverId,
        r.channel_id,
      )
    }
  })
}

/** Set a channel's archived flag. Used for the optimistic un-archive on send. */
export async function setChannelArchived(
  db: SQLiteDatabase,
  serverId: string,
  channelId: string,
  archived: boolean,
): Promise<void> {
  await db.runAsync(
    `UPDATE channels SET archived = ? WHERE server_id = ? AND channel_id = ?`,
    archived ? 1 : 0,
    serverId,
    channelId,
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
