import type { SQLiteDatabase } from 'expo-sqlite'
import { DEFAULT_CHANNEL, type ItemRow } from './schema'
import { upsertServer, updateServerPreview } from './servers'
import { upsertChannel, updateChannelPreview } from './channels'

export async function insertItem(
  db: SQLiteDatabase,
  opts: {
    id: string
    serverId: string
    channel?: string
    kind: string
    data: object
    turnId?: string
  },
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO items (id, server_id, channel, kind, data, turn_id, done, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    opts.id,
    opts.serverId,
    opts.channel ?? DEFAULT_CHANNEL,
    opts.kind,
    JSON.stringify(opts.data),
    opts.turnId ?? null,
    Date.now(),
  )
}

export async function updateItemData(
  db: SQLiteDatabase,
  id: string,
  data: object,
): Promise<void> {
  await db.runAsync(`UPDATE items SET data = ? WHERE id = ?`, JSON.stringify(data), id)
}

export async function markItemDone(
  db: SQLiteDatabase,
  id: string,
  data: object,
): Promise<void> {
  await db.runAsync(
    `UPDATE items SET done = 1, data = ? WHERE id = ?`,
    JSON.stringify(data),
    id,
  )
}

export async function deleteItem(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`DELETE FROM items WHERE id = ?`, id)
}

/** Fetch a single item row by its id. Returns null if not found. */
export async function getItemById(db: SQLiteDatabase, id: string): Promise<ItemRow | null> {
  const row = await db.getFirstAsync<ItemRow>(`SELECT * FROM items WHERE id = ? LIMIT 1`, id)
  return row ?? null
}

// ---------------------------------------------------------------------------
// Paginated readers — cursor is items.local_id (monotonic insertion order).
// All return rows in ASC display order regardless of which direction we fetch.
// ---------------------------------------------------------------------------

/** Newest `limit` rows for a (server, channel) conversation, in ASC order. */
export async function loadRecentItems(
  db: SQLiteDatabase,
  serverId: string,
  channel: string,
  limit: number,
): Promise<ItemRow[]> {
  const rows = await db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE server_id = ? AND channel = ? ORDER BY local_id DESC LIMIT ?`,
    serverId,
    channel,
    limit,
  )
  return rows.reverse()
}

/** Up to `limit` rows older than `beforeLocalId` in this conversation, ASC order. */
export async function loadOlderThan(
  db: SQLiteDatabase,
  serverId: string,
  channel: string,
  beforeLocalId: number,
  limit: number,
): Promise<ItemRow[]> {
  const rows = await db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE server_id = ? AND channel = ? AND local_id < ?
     ORDER BY local_id DESC LIMIT ?`,
    serverId,
    channel,
    beforeLocalId,
    limit,
  )
  return rows.reverse()
}

/** Up to `limit` rows newer than `afterLocalId`, in ASC order. */
export async function loadNewerThan(
  db: SQLiteDatabase,
  serverId: string,
  afterLocalId: number,
  limit: number,
): Promise<ItemRow[]> {
  return db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE server_id = ? AND local_id > ?
     ORDER BY local_id ASC LIMIT ?`,
    serverId,
    afterLocalId,
    limit,
  )
}

/**
 * Load a window centered on `itemId`: up to `beforeLimit` rows at or before its
 * local_id (target included), plus up to `afterLimit` rows after it.
 * Returns null if the item is not found.
 */
export async function loadAroundItem(
  db: SQLiteDatabase,
  serverId: string,
  itemId: string,
  beforeLimit: number,
  afterLimit: number,
): Promise<{ before: ItemRow[]; after: ItemRow[] } | null> {
  const target = await db.getFirstAsync<{ local_id: number }>(
    `SELECT local_id FROM items WHERE server_id = ? AND id = ? LIMIT 1`,
    serverId,
    itemId,
  )
  if (!target) return null

  const beforeDesc = await db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE server_id = ? AND local_id <= ?
     ORDER BY local_id DESC LIMIT ?`,
    serverId,
    target.local_id,
    beforeLimit,
  )
  const after = await loadNewerThan(db, serverId, target.local_id, afterLimit)
  return { before: beforeDesc.reverse(), after }
}

/** Look up the local_id for an item id. Returns null if not found. */
export async function findItemLocalId(
  db: SQLiteDatabase,
  itemId: string,
): Promise<number | null> {
  const row = await db.getFirstAsync<{ local_id: number }>(
    `SELECT local_id FROM items WHERE id = ? LIMIT 1`,
    itemId,
  )
  return row?.local_id ?? null
}

// ---------------------------------------------------------------------------
// Composite write
// ---------------------------------------------------------------------------

/**
 * Ensure the server + channel rows exist (FK prerequisite), insert the item,
 * and optionally update both preview columns. This is the single write path
 * for any new item — callers never need to manually sequence the three steps.
 *
 * Pass `preview` when the item should become the conversation's last-message
 * preview (outgoing messages, files). Omit it for tools, prompts, and other
 * items that shouldn't change the preview.
 */
export async function persistItem(
  db: SQLiteDatabase,
  item: {
    id: string
    serverId: string
    channel?: string
    kind: string
    data: object
    turnId?: string
  },
  preview?: string,
): Promise<void> {
  const channel = item.channel ?? DEFAULT_CHANNEL
  await upsertServer(db, item.serverId)
  await upsertChannel(db, item.serverId, channel)
  await insertItem(db, item)
  if (preview !== undefined) {
    await updateServerPreview(db, item.serverId, preview)
    await updateChannelPreview(db, item.serverId, channel, preview)
  }
}
