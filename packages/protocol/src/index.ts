/**
 * aji-chat wire protocol
 *
 * Discriminated unions describing every event that flows over the WebSocket
 * between the server (agent-side) and the mobile client. See
 * docs/agent-protocol.md for the design rationale.
 *
 * Conventions:
 * - All events carry `type` as the discriminant.
 * - IDs (`message_id`, `tool_id`, `prompt_id`) are opaque strings minted by
 *   the server. The client echoes them back when responding to a prompt.
 * - Streaming text uses append-only `text_delta` events; clients concatenate
 *   them in order until `message_end` arrives.
 */

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type Role = 'assistant' | 'user' | 'system'

export type AgentStatus = 'thinking' | 'working' | 'idle'

export interface MessageStart {
  type: 'message_start'
  id: string
  role: Role
}

export interface TextDelta {
  type: 'text_delta'
  id: string
  text: string
}

export interface MessageEnd {
  type: 'message_end'
  id: string
}

export interface ToolStart {
  type: 'tool_start'
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolEnd {
  type: 'tool_end'
  id: string
  /** Free-form tool output. Render is up to the client. */
  result: unknown
  /** Set when the tool errored. */
  error?: string
}

export interface Status {
  type: 'status'
  value: AgentStatus
}

/**
 * Three-button approval prompt. Mirrors Hermes's send_slash_confirm and
 * send_exec_approval. The client should render `options` as buttons and
 * respond with a `PromptResponse` carrying the chosen option's `id`.
 */
export interface PermissionRequest {
  type: 'permission_request'
  id: string
  title: string
  message: string
  options: PromptOption[]
}

/**
 * Multi-choice question. Mirrors Hermes's send_clarify. Choices are shown
 * as buttons; the client responds with the chosen option's `id`.
 */
export interface Clarify {
  type: 'clarify'
  id: string
  question: string
  choices: PromptOption[]
}

/**
 * Remove a previously rendered prompt without requiring the client to answer.
 * Useful when a mirrored approval flow times out or is resolved elsewhere.
 */
export interface PromptDismiss {
  type: 'prompt_dismiss'
  id: string
}

export interface PromptOption {
  /** Stable ID echoed back in PromptResponse.choice */
  id: string
  /** Display label */
  label: string
}

export type ServerEvent =
  | MessageStart
  | TextDelta
  | MessageEnd
  | ToolStart
  | ToolEnd
  | Status
  | PermissionRequest
  | Clarify
  | PromptDismiss

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface UserMessage {
  type: 'user_message'
  text: string
}

export interface PromptResponse {
  type: 'prompt_response'
  /** The id of the originating PermissionRequest or Clarify event */
  id: string
  /** The id of the chosen PromptOption */
  choice: string
}

export type ClientEvent = UserMessage | PromptResponse

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Either direction. Useful for shared logging / transport code. */
export type AnyEvent = ServerEvent | ClientEvent

/** Narrow on `type`. Example: `if (isServerEvent(e, 'text_delta')) ...` */
export function isServerEvent<T extends ServerEvent['type']>(
  event: ServerEvent,
  type: T,
): event is Extract<ServerEvent, { type: T }> {
  return event.type === type
}

export function isClientEvent<T extends ClientEvent['type']>(
  event: ClientEvent,
  type: T,
): event is Extract<ClientEvent, { type: T }> {
  return event.type === type
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let _idSeq = 0
/** Generate a short opaque id like "msg_lk3p9q_4". */
export function newId(prefix = 'id'): string {
  _idSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${_idSeq}`
}

/**
 * Construct the three events that make up a complete, non-streaming text
 * message. Useful for "send me a plain message from the server" cases.
 */
export function textMessage(text: string, role: Role = 'assistant'): ServerEvent[] {
  const id = newId('msg')
  return [
    { type: 'message_start', id, role },
    { type: 'text_delta', id, text },
    { type: 'message_end', id },
  ]
}
