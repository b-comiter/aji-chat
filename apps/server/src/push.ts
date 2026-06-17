/**
 * Remote push delivery — a swappable seam, not core router logic.
 *
 * The aji-chat server stays a dumb router: it broadcasts ServerEvents to WS
 * clients and forwards ClientEvents to webhooks. But a push notification has to
 * originate server-side, because the phone can't notify itself once it's been
 * backgrounded or killed. This module is the one place that reaches out to a
 * delivery provider (Expo's push service), kept isolated so it can be replaced
 * (APNs/FCM direct, a separate notifier process, etc.) without touching index.ts.
 *
 * The server's broadcast path calls `observeForPush(event)` for every event and
 * is otherwise unaware of how — or whether — a push is sent. All the "smarts"
 * (which events alert, the message-preview text, mute filtering) live here:
 *
 *  - Streamed text is accumulated across `text_delta`s keyed by message id and
 *    sent as a preview on `message_end`, so the notification body reads like
 *    WhatsApp/Telegram ("Assistant: here's the answer…") rather than a bare
 *    "New message". Accumulation is bounded and lives only in this delivery
 *    module — the core broadcast path never grows message state.
 *  - Each push carries `data: { serverId, channel }` so the app can deep-link
 *    straight to the conversation when tapped.
 *  - Muted servers are filtered here; the phone syncs its mute state via the
 *    `set_mute` event.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '@aji/protocol'
import { loadJson, saveJson } from './persist'

const DATA_DIR = process.env.AJI_DATA_DIR || join(homedir(), '.aji-chat')
const PUSH_TOKENS_FILE = join(DATA_DIR, 'push_tokens.json')
const PUSH_MUTES_FILE = join(DATA_DIR, 'push_mutes.json')

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Cap the accumulated preview so a long message doesn't bloat the buffer or the
// notification (which the OS truncates anyway).
const MAX_PREVIEW = 180

// Registered Expo push tokens and muted server ids. Persisted so they survive a
// server restart — a phone only re-syncs when it reconnects.
const tokens = new Set<string>()
const mutedServers = new Set<string>()

// Per-message text accumulation for preview bodies, keyed by message id. Only
// non-user messages are buffered (gated at message_start), which is also how we
// avoid alerting on the user's own echoed message — message_end carries no role.
type Inflight = { serverId?: string; channel?: string; text: string }
const inflight = new Map<string, Inflight>()

export interface PushNote {
  title: string
  body: string
  data: { serverId?: string; channel?: string }
}

// ---------------------------------------------------------------------------
// Persisted registries
// ---------------------------------------------------------------------------

export function loadPushState(): void {
  const t = loadJson<string[]>(PUSH_TOKENS_FILE)
  if (t) for (const x of t) tokens.add(x)
  const m = loadJson<string[]>(PUSH_MUTES_FILE)
  if (m) for (const x of m) mutedServers.add(x)
}

function saveTokens(): void {
  saveJson(PUSH_TOKENS_FILE, [...tokens])
}
function saveMutes(): void {
  saveJson(PUSH_MUTES_FILE, [...mutedServers])
}

/** Add a token to the registry. Returns true if it was newly added. */
export function registerPushToken(token: string): boolean {
  if (!token || tokens.has(token)) return false
  tokens.add(token)
  saveTokens()
  return true
}

export function pushTokenCount(): number {
  return tokens.size
}

/** Mirror the phone's per-server mute toggle so muted servers don't push. */
export function setServerMuted(serverId: string, muted: boolean): void {
  if (muted) mutedServers.add(serverId)
  else mutedServers.delete(serverId)
  saveMutes()
}

// ---------------------------------------------------------------------------
// Pure content helpers
// ---------------------------------------------------------------------------

function titleFor(displayName?: string, serverId?: string, channel?: string): string {
  const server = displayName || serverId || 'aji-chat'
  // Always show "server:channel" so you can tell which conversation a
  // notification belongs to. Only omit the channel when the event carries none.
  return channel ? `${server}:${channel}` : server
}

/**
 * Per-conversation collapse key. iOS/Android coalesce notifications sharing a
 * collapseId into a single one that updates in place, so a burst of replies from
 * one chat reads as one updating notification instead of a growing stack. Scoped
 * to (serverId, channel) so distinct conversations never collapse into each other.
 */
function collapseIdFor(serverId?: string, channel?: string): string | undefined {
  if (!serverId) return undefined
  return `${serverId}:${channel ?? 'general'}`
}

/** Collapse whitespace and truncate to a notification-friendly preview. */
export function messagePreview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New message'
  return clean.length > MAX_PREVIEW ? `${clean.slice(0, MAX_PREVIEW - 1)}…` : clean
}

/**
 * Pure delivery decision + content for one event. `text` is the accumulated
 * message body (supplied for `message_end`); `serverId`/`channel` override the
 * event's own routing fields with the values captured at `message_start`, which
 * are more reliable for deep-linking. Returns null for events that shouldn't
 * alert. Role-gating for streamed text lives in `observeForPush` (message_end
 * carries no role), so this returns a note for any message_end it's handed.
 */
export function notificationFor(
  event: ServerEvent,
  opts: { displayName?: string; text?: string; serverId?: string; channel?: string } = {},
): PushNote | null {
  const serverId = opts.serverId ?? ('serverId' in event ? event.serverId : undefined)
  const channel = opts.channel ?? ('channel' in event ? event.channel : undefined)
  const data = { serverId, channel }
  const title = titleFor(opts.displayName, serverId, channel)

  if (event.type === 'message_end') {
    return { title, body: messagePreview(opts.text ?? ''), data }
  }
  if (event.type === 'file') {
    if (event.role === 'user') return null
    return { title, body: event.text?.trim() || 'Sent an attachment', data }
  }
  return null
}

// ---------------------------------------------------------------------------
// Stateful observation + delivery
// ---------------------------------------------------------------------------

/**
 * Called for every broadcast event. Accumulates streamed text and fires a push
 * on message completion (or immediately for a file). Never throws.
 */
export function observeForPush(event: ServerEvent, displayName?: string): void {
  switch (event.type) {
    case 'message_start':
      if (event.role === 'user') return
      inflight.set(event.id, { serverId: event.serverId, channel: event.channel, text: '' })
      return
    case 'text_delta': {
      const e = inflight.get(event.id)
      if (e && e.text.length < MAX_PREVIEW) e.text += event.text
      return
    }
    case 'message_end': {
      const e = inflight.get(event.id)
      if (!e) return
      inflight.delete(event.id)
      const note = notificationFor(event, {
        displayName,
        text: e.text,
        serverId: e.serverId,
        channel: e.channel,
      })
      if (note) void deliver(note)
      return
    }
    case 'file': {
      const note = notificationFor(event, { displayName })
      if (note) void deliver(note)
      return
    }
    default:
      return
  }
}

/**
 * Best-effort fan-out of one notification. Never throws and never blocks the
 * broadcast. Skips muted servers. Tokens Expo reports as `DeviceNotRegistered`
 * are pruned so the registry self-heals after an app uninstall.
 */
async function deliver(note: PushNote): Promise<void> {
  if (tokens.size === 0) return
  if (note.data.serverId && mutedServers.has(note.data.serverId)) return

  const collapseId = collapseIdFor(note.data.serverId, note.data.channel)
  const recipients = [...tokens]
  const messages = recipients.map((to) => ({
    to,
    title: note.title,
    body: note.body,
    data: note.data,
    sound: 'default' as const,
    ...(collapseId ? { collapseId } : {}),
  }))

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
    const json = (await res.json().catch(() => null)) as {
      data?: Array<{ status: string; details?: { error?: string } }>
    } | null

    let pruned = false
    json?.data?.forEach((ticket, i) => {
      if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        tokens.delete(recipients[i])
        pruned = true
      }
    })
    if (pruned) saveTokens()
  } catch {
    // Swallow — a push outage must never disrupt event broadcast.
  }
}
