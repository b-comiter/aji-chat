/**
 * SQLite schema, migrations, and CRUD helpers for aji-chat persistence.
 *
 * Two tables:
 *  agents — one row per known agent, tracks preview text and last status
 *  items  — all messages, tool calls, and prompts, stored as JSON blobs
 *
 * Called via SQLiteProvider / useSQLiteContext (expo-sqlite v15+).
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
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

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
      agent_id   TEXT    NOT NULL REFERENCES agents(id),
      kind       TEXT    NOT NULL,
      data       TEXT    NOT NULL,
      turn_id    TEXT,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS items_by_agent ON items(agent_id, created_at);
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
  agent_id: string
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
    agentId: string
    kind: string
    data: object
    turnId?: string
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO items (id, agent_id, kind, data, turn_id, done, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    opts.id,
    opts.agentId,
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
  agentId: string,
): Promise<ItemRow[]> {
  return db.getAllAsync<ItemRow>(
    `SELECT * FROM items WHERE agent_id = ? ORDER BY created_at ASC`,
    agentId,
  )
}

// ---------------------------------------------------------------------------
// Dev / debug utilities
// ---------------------------------------------------------------------------

/** Delete all items for one agent. Keeps the agent row (preserves preview/status). */
export async function clearAgentHistory(
  db: SQLiteDatabase,
  agentId: string,
): Promise<void> {
  await db.runAsync(`DELETE FROM items WHERE agent_id = ?`, agentId)
}

/** Delete every item and every agent row — full DB reset. */
export async function wipeAllHistory(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM items; DELETE FROM agents;`)
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
      `SELECT kind, COUNT(*) as cnt FROM items WHERE agent_id = ? GROUP BY kind`,
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
