import type { SQLiteDatabase } from 'expo-sqlite'

export const DEFAULT_CHANNEL = 'general'

export const SERVER_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'hermes':      'Hermes',
  'simulate':    'Simulator',
  'unknown':     'Unknown Server',
}

export function serverDisplayName(id: string): string {
  return SERVER_DISPLAY_NAMES[id] ?? id
}

export type ServerRow = {
  id: string
  display_name: string
  last_message_preview: string | null
  last_event_at: number | null
  last_status: string
  /** `data:<base64>` (picked image) or `emoji:<glyph>` (preset), or null. */
  avatar: string | null
  /** Adapter-advertised mono-channel default (0/1) or null if unadvertised. */
  mono_channel_advertised: number | null
  /** User's local mono-channel override (0/1) or null if unset. */
  mono_channel_override: number | null
}

/** Effective mono-channel: local override wins, else advertised, else false. */
export function isMonoChannel(row: Pick<ServerRow, 'mono_channel_advertised' | 'mono_channel_override'>): boolean {
  const v = row.mono_channel_override ?? row.mono_channel_advertised ?? 0
  return v === 1
}

export type ItemRow = {
  local_id: number
  id: string
  server_id: string
  channel: string
  kind: string
  data: string        // JSON — deserialise with JSON.parse
  turn_id: string | null
  done: number        // 0 | 1
  created_at: number  // unix ms
}

export type ChannelRow = {
  server_id: string
  channel_id: string
  display_name: string
  last_message_preview: string | null
  last_event_at: number | null
  last_status: string
  /** User-defined sort slot (0-based). Ties break by recency. Default 0. */
  position: number
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * Current schema version. Bump to force a clean rebuild on next launch.
 *
 * v8 renamed the physical tables/columns to match the protocol vocabulary
 * (`agents`→`servers`, `chat_id`→`server_id`). v9 adds `channels.position` for
 * user-defined channel ordering (drag-to-reorder). This is a dev project with
 * disposable local data, so rather than carry the incremental column patches
 * forward we drop everything and recreate the final shape in one block.
 */
const SCHEMA_VERSION = 9

export async function migrateDb(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;')

  const [{ user_version: version }] = await db.getAllAsync<{ user_version: number }>('PRAGMA user_version')

  if (version < SCHEMA_VERSION) {
    // Disposable local data — drop all known tables (old and new names) and
    // recreate fresh below. Children before parents to respect FKs.
    await db.execAsync(`
      DROP TABLE IF EXISTS items;
      DROP TABLE IF EXISTS channels;
      DROP TABLE IF EXISTS command_cache;
      DROP TABLE IF EXISTS agents;
      DROP TABLE IF EXISTS servers;
    `)
  }

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS servers (
      id                      TEXT PRIMARY KEY,
      display_name            TEXT NOT NULL,
      last_message_preview    TEXT,
      last_event_at           INTEGER,
      last_status             TEXT NOT NULL DEFAULT 'idle',
      avatar                  TEXT,
      mono_channel_advertised INTEGER,
      mono_channel_override   INTEGER
    );

    CREATE TABLE IF NOT EXISTS channels (
      server_id            TEXT NOT NULL REFERENCES servers(id),
      channel_id           TEXT NOT NULL,
      display_name         TEXT NOT NULL,
      last_message_preview TEXT,
      last_event_at        INTEGER,
      last_status          TEXT NOT NULL DEFAULT 'idle',
      position             INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (server_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS items (
      local_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT    NOT NULL,
      server_id  TEXT    NOT NULL REFERENCES servers(id),
      channel    TEXT    NOT NULL DEFAULT 'general',
      kind       TEXT    NOT NULL,
      data       TEXT    NOT NULL,
      turn_id    TEXT,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS items_id_unique ON items(id);
    CREATE INDEX IF NOT EXISTS items_by_conv ON items(server_id, channel, created_at);

    CREATE TABLE IF NOT EXISTS command_cache (
      server_id  TEXT PRIMARY KEY REFERENCES servers(id),
      commands   TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  if (version < SCHEMA_VERSION) {
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
}
