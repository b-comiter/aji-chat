import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChannelInfo, Channels } from '@aji/protocol'
import { loadJson, saveJson } from './persist'

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

/**
 * Idempotently upsert a channel into a server's channel list, mutating and
 * returning the list. An existing channel id keeps its position and only
 * refreshes its `displayName` / `cwd` when a new non-empty value is supplied; an
 * unknown id is appended. `cwd` is opaque to the server — it just persists it so
 * session-managing adapters can read it back via `GET /channels`.
 */
export function upsertChannelInfo(
  list: ChannelInfo[],
  channel: string,
  displayName?: string,
  cwd?: string,
): ChannelInfo[] {
  const existing = list.find((c) => c.id === channel)
  if (existing) {
    if (displayName) existing.displayName = displayName
    if (cwd) existing.cwd = cwd
  } else {
    list.push({ id: channel, ...(displayName ? { displayName } : {}), ...(cwd ? { cwd } : {}) })
  }
  return list
}

/**
 * Remove a channel from a server's list, returning a new array. Idempotent — an
 * unknown id leaves the list unchanged (so deleting a never-registered, local-only
 * channel is a safe no-op).
 */
export function removeChannelInfo(list: ChannelInfo[], channel: string): ChannelInfo[] {
  return list.filter((c) => c.id !== channel)
}

// ---------------------------------------------------------------------------
// Stateful registry
// ---------------------------------------------------------------------------

const CHANNELS_FILE = process.env.AJI_DATA_DIR
  ? join(process.env.AJI_DATA_DIR, 'channels.json')
  : join(homedir(), '.aji-chat', 'channels.json')

const channelsByServer = new Map<string, ChannelInfo[]>()

export function loadChannels(): void {
  const obj = loadJson<Record<string, ChannelInfo[]>>(CHANNELS_FILE)
  if (obj) for (const [serverId, list] of Object.entries(obj)) channelsByServer.set(serverId, list)
}

function saveChannels(): void {
  const obj: Record<string, ChannelInfo[]> = {}
  for (const [serverId, list] of channelsByServer) obj[serverId] = list
  saveJson(CHANNELS_FILE, obj)
}

/** Upsert a channel into a server's registry and persist. */
export function registerChannel(serverId: string, channel: string, displayName?: string, cwd?: string): void {
  const list = upsertChannelInfo(channelsByServer.get(serverId) ?? [], channel, displayName, cwd)
  channelsByServer.set(serverId, list)
  saveChannels()
}

/** Remove a channel from a server's registry and persist. No-op if absent. */
export function deregisterChannel(serverId: string, channel: string): void {
  const current = channelsByServer.get(serverId)
  if (!current) return
  channelsByServer.set(serverId, removeChannelInfo(current, channel))
  saveChannels()
}

/** Build the current `channels` ServerEvent for a server (empty list if none). */
export function channelsEvent(serverId: string): Channels {
  return { type: 'channels', serverId, channels: channelsByServer.get(serverId) ?? [] }
}

/** Iterate all server IDs that have a channel list. Used for replay on connect. */
export function allServerIds(): IterableIterator<string> {
  return channelsByServer.keys()
}
