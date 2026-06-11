/**
 * Conversation-key helpers for the Server → Channel hierarchy.
 *
 * A conversation is the pair `(server, channel)` where `server` is the protocol
 * `serverId` (e.g. "hermes") and `channel` is a channel within it (e.g.
 * "daily-brief"). We collapse the pair into a single opaque string key used for:
 *   - WebSocket subscription routing (`subscribe(convKey(...), handler)`)
 *   - in-flight event bookkeeping
 *
 * SQLite keeps `server_id` and `channel` as separate columns — the
 * composite key is purely an in-memory convenience.
 */

import { DEFAULT_CHANNEL } from './database'

const SEP = '/'

/** Compose a conversation key from a server and channel. */
export function convKey(server: string, channel: string = DEFAULT_CHANNEL): string {
  return `${server}${SEP}${channel}`
}

/**
 * Parse a conversation key back into `{ server, channel }`. A key with no
 * separator is treated as a bare server with the default channel (tolerant of
 * legacy/agent-only ids). Any separators beyond the first stay in the channel
 * so channel names may themselves contain a slash.
 */
export function parseConvKey(key: string): { server: string; channel: string } {
  const idx = key.indexOf(SEP)
  if (idx === -1) return { server: key, channel: DEFAULT_CHANNEL }
  return { server: key.slice(0, idx), channel: key.slice(idx + 1) || DEFAULT_CHANNEL }
}
