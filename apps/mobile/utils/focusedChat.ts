/**
 * Tracks which conversation the user is currently viewing, so a push that
 * arrives while the app is foregrounded on that exact chat can be suppressed
 * (WhatsApp/Telegram show an in-app cue, not a banner, for the open chat).
 *
 * Plain module state — read synchronously inside the notification handler, which
 * can't await. The chat screen sets it on focus and clears it on blur.
 */
const DEFAULT_CHANNEL = 'general'

let focused: { serverId: string; channel: string } | null = null

const norm = (channel?: string): string => channel || DEFAULT_CHANNEL

export function setFocusedChat(serverId: string | null, channel?: string): void {
  focused = serverId ? { serverId, channel: norm(channel) } : null
}

export function isChatFocused(serverId?: string, channel?: string): boolean {
  return !!focused && !!serverId && focused.serverId === serverId && focused.channel === norm(channel)
}
