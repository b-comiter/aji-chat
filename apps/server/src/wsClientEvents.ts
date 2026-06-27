import { WebSocket } from 'ws'
import type { ClientEvent, PromptResponse, ServerEvent } from '@aji/protocol'
import { channelsEvent, deregisterChannel, registerChannel } from './channels'
import { registerPushToken, setServerMuted } from './push'
import { selectMissedEvents } from './replay'

type LogFn = (direction: '➡️' | '⬅️' | '✅' | '❌' | ' ', tag: string, detail?: unknown) => void

type Params = {
  ws: WebSocket
  event: ClientEvent
  eventBuffer: Array<{ seq: number; event: ServerEvent }>
  nextSeq: number
  envelope: (seq: number, event: ServerEvent) => string
  replayCommandsTo: (ws: WebSocket) => void
  broadcast: (event: ServerEvent) => void
  resolvePrompt: (event: PromptResponse) => boolean
  dispatchToWebhooks: (event: ClientEvent) => void
  log: LogFn
}

function sendMissedEvents({
  ws,
  after,
  eventBuffer,
  nextSeq,
  envelope,
  log,
}: {
  ws: WebSocket
  after: number
  eventBuffer: Array<{ seq: number; event: ServerEvent }>
  nextSeq: number
  envelope: (seq: number, event: ServerEvent) => string
  log: LogFn
}) {
  // Restart-aware: if the client cursor is ahead of this process, replay all.
  const missed = selectMissedEvents(eventBuffer, after, nextSeq)
  const restarted = after >= nextSeq
  log(' ', `ws:get_missed_events  after=${after} replaying=${missed.length}${restarted ? ' (server restart - full replay)' : ''}`)

  for (const entry of missed) {
    if (ws.readyState === WebSocket.OPEN) ws.send(envelope(entry.seq, entry.event))
  }
}

function shouldDispatchWebhook(event: ClientEvent): boolean {
  // register_push / set_mute are infra-only control events from the phone.
  return event.type !== 'register_push' && event.type !== 'set_mute'
}

export function handleWsClientEvent({
  ws,
  event,
  eventBuffer,
  nextSeq,
  envelope,
  replayCommandsTo,
  broadcast,
  resolvePrompt,
  dispatchToWebhooks,
  log,
}: Params): void {
  if (event.type === 'prompt_response') {
    resolvePrompt(event)
  } else if (event.type === 'get_commands') {
    if (ws.readyState === WebSocket.OPEN) replayCommandsTo(ws)
  } else if (event.type === 'create_channel') {
    registerChannel(event.serverId, event.channel, event.displayName, event.cwd)
    broadcast(channelsEvent(event.serverId))
  } else if (event.type === 'delete_channel') {
    deregisterChannel(event.serverId, event.channel)
    broadcast(channelsEvent(event.serverId))
  } else if (event.type === 'get_missed_events') {
    sendMissedEvents({ ws, after: event.after_seq, eventBuffer, nextSeq, envelope, log })
  } else if (event.type === 'register_push') {
    if (registerPushToken(event.token)) {
      log(' ', `ws:register_push  ${event.platform ?? '-'} token=...${event.token.slice(-12)}`)
    }
  } else if (event.type === 'set_mute') {
    setServerMuted(event.serverId, event.muted)
    log(' ', `ws:set_mute  serverId=${event.serverId} muted=${event.muted}`)
  }

  if (shouldDispatchWebhook(event)) {
    dispatchToWebhooks(event)
  }
}
