/**
 * SQLite schema, migrations, and CRUD helpers for aji-chat persistence.
 *
 * Two tables:
 *  agents — one row per known agent, tracks preview text and last status
 *  items  — all messages, tool calls, and prompts, stored as JSON blobs
 *            keyed by chat_id (= the agent identity, e.g. 'claude-code')
 */
import type { SQLiteDatabase } from 'expo-sqlite'

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'hermes':      'Hermes',
  'simulate':    'Simulator',
  'unknown':     'Unknown Agent',
}

export function agentDisplayName(id: string): string {
  return AGENT_DISPLAY_NAMES[id] ?? id
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function migrateDb(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;')

  const [{ user_version: version }] = await db.getAllAsync<{ user_version: number }>('PRAGMA user_version')

  if (version < 2) {
    // v0→v2: agent_id renamed to chat_id. Dev project — drop and recreate.
    await db.execAsync('DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS agents;')
    await db.execAsync('PRAGMA user_version = 2')
  }

  if (version < 3) {
    // v2→v3: add key-value settings table for user preferences (e.g. theme).
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    await db.execAsync('PRAGMA user_version = 3')
  }

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS agents (
      id                   TEXT PRIMARY KEY,
      display_name         TEXT NOT NULL,
      last_message_preview TEXT,
      last_event_at        INTEGER,
      last_status          TEXT NOT NULL DEFAULT 'idle'
    );

    CREATE TABLE IF NOT EXISTS items (
      local_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT    NOT NULL,
      chat_id    TEXT    NOT NULL REFERENCES agents(id),
      kind       TEXT    NOT NULL,
      data       TEXT    NOT NULL,
      turn_id    TEXT,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS items_by_chat ON items(chat_id, created_at);
  `)
}

// ---------------------------------------------------------------------------
// Row types (what SQLite gives back)
// ---------------------------------------------------------------------------

export type AgentRow = {
  id: string
  display_name: string
  last_message_preview: string | null
  last_event_at: number | null
  last_status: string
}

export type ItemRow = {
  local_id: number
  id: string
  chat_id: string
  kind: string
  data: string        // JSON — deserialise with JSON.parse
  turn_id: string | null
  done: number        // 0 | 1
  created_at: number  // unix ms
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Upsert an agent row. Creates it if new; touches last_event_at otherwise. */
export async function upsertAgent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO agents (id, display_name, last_event_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_event_at = excluded.last_event_at`,
    id,
    agentDisplayName(id),
    Date.now(),
  )
}

export async function updateAgentStatus(
  db: SQLiteDatabase,
  id: string,
  status: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO agents (id, display_name, last_status)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_status = excluded.last_status`,
    id,
    agentDisplayName(id),
    status,
  )
}

export async function updateAgentPreview(
  db: SQLiteDatabase,
  id: string,
  preview: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE agents SET last_message_preview = ?, last_event_at = ? WHERE id = ?`,
    preview.slice(0, 120),
    Date.now(),
    id,
  )
}

export async function getAllAgents(db: SQLiteDatabase): Promise<AgentRow[]> {
  return db.getAllAsync<AgentRow>(
    `SELECT * FROM agents ORDER BY last_event_at DESC`,
  )
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function insertItem(
  db: SQLiteDatabase,
  opts: {
    id: string
    chatId: string
    kind: string
    data: object
    turnId?: string
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO items (id, chat_id, kind, data, turn_id, done, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    opts.id,
    opts.chatId,
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
  await db.runAsync(
    `UPDATE items SET data = ? WHERE id = ?`,
    JSON.stringify(data),
    id,
  )
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

export async function getItemsForAgent(
  db: SQLiteDatabase,
  chatId: string,
): Promise<ItemRow[]> {
  return db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE chat_id = ? ORDER BY created_at ASC`,
    chatId,
  )
}

// ---------------------------------------------------------------------------
// Paginated readers — cursor is items.local_id (monotonic insertion order)
// All return rows in ASC display order regardless of which direction we fetch.
// ---------------------------------------------------------------------------

/** Newest `limit` rows for a chat, in ASC order (oldest first). */
export async function loadRecentItems(
  db: SQLiteDatabase,
  chatId: string,
  limit: number,
): Promise<ItemRow[]> {
  const rows = await db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE chat_id = ? ORDER BY local_id DESC LIMIT ?`,
    chatId,
    limit,
  )
  return rows.reverse()
}

/** Up to `limit` rows older than `beforeLocalId`, in ASC order. */
export async function loadOlderThan(
  db: SQLiteDatabase,
  chatId: string,
  beforeLocalId: number,
  limit: number,
): Promise<ItemRow[]> {
  const rows = await db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE chat_id = ? AND local_id < ?
     ORDER BY local_id DESC LIMIT ?`,
    chatId,
    beforeLocalId,
    limit,
  )
  return rows.reverse()
}

/** Up to `limit` rows newer than `afterLocalId`, in ASC order. */
export async function loadNewerThan(
  db: SQLiteDatabase,
  chatId: string,
  afterLocalId: number,
  limit: number,
): Promise<ItemRow[]> {
  return db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE chat_id = ? AND local_id > ?
     ORDER BY local_id ASC LIMIT ?`,
    chatId,
    afterLocalId,
    limit,
  )
}

/**
 * Load a window centered on `itemId`: up to `beforeLimit` rows at or before its
 * local_id (target included), plus up to `afterLimit` rows after it.
 * Returns separate arrays so callers can derive hasMore from each side.
 * Returns null if the item is not found.
 */
export async function loadAroundItem(
  db: SQLiteDatabase,
  chatId: string,
  itemId: string,
  beforeLimit: number,
  afterLimit: number,
): Promise<{ before: ItemRow[]; after: ItemRow[] } | null> {
  const target = await db.getFirstAsync<{ local_id: number }>(
    `SELECT local_id FROM items WHERE chat_id = ? AND id = ? LIMIT 1`,
    chatId,
    itemId,
  )
  if (!target) return null

  const beforeDesc = await db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE chat_id = ? AND local_id <= ?
     ORDER BY local_id DESC LIMIT ?`,
    chatId,
    target.local_id,
    beforeLimit,
  )
  const after = await loadNewerThan(db, chatId, target.local_id, afterLimit)
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
// Dev / debug utilities
// ---------------------------------------------------------------------------

/** Delete all items for one agent. Keeps the agent row (preserves preview/status). */
export async function clearAgentHistory(
  db: SQLiteDatabase,
  chatId: string,
): Promise<void> {
  await db.runAsync(`DELETE FROM items WHERE chat_id = ?`, chatId)
}

/** Delete every item and every agent row — full DB reset. */
export async function wipeAllHistory(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM items; DELETE FROM agents;`)
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

export type DbDumpResult = {
  agents: AgentRow[]
  itemCounts: Record<string, { messages: number; tools: number; prompts: number }>
}

/** Collect all agents + per-kind item counts — used by /view-db. */
export async function getDbDump(db: SQLiteDatabase): Promise<DbDumpResult> {
  const agents = await getAllAgents(db)
  const itemCounts: DbDumpResult['itemCounts'] = {}

  for (const agent of agents) {
    const rows = await db.getAllAsync<{ kind: string; cnt: number }>(
      `SELECT kind, COUNT(*) as cnt FROM items WHERE chat_id = ? GROUP BY kind`,
      agent.id,
    )
    itemCounts[agent.id] = { messages: 0, tools: 0, prompts: 0 }
    for (const row of rows) {
      if (row.kind === 'message') itemCounts[agent.id].messages = row.cnt
      else if (row.kind === 'tool') itemCounts[agent.id].tools = row.cnt
      else if (row.kind === 'prompt') itemCounts[agent.id].prompts = row.cnt
    }
  }

  return { agents, itemCounts }
}
