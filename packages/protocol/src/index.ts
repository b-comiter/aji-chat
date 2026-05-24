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

/**
 * Optional grouping ID that ties together every event belonging to a single
 * agent turn (user message → tool calls → assistant response). Set by adapters
 * with turn boundaries available (e.g. the Hermes plugin mints one in
 * `on_processing_start`). The Claude Code hook path leaves this unset and the
 * mobile UI falls back to chronological ordering.
 */
export type TurnId = string

/**
 * Identifies which agent sent the event. Set by adapters that know their
 * identity (e.g. 'claude-code', 'hermes', 'simulate'). Events without this
 * field are attributed to 'unknown'. Modular — future agent pairing /
 * registration layers on top without schema changes.
 */
export type AgentId = string

export interface MessageStart {
  type: 'message_start'
  id: string
  role: Role
  turn_id?: TurnId
  agent?: AgentId
}

export interface TextDelta {
  type: 'text_delta'
  id: string
  text: string
  turn_id?: TurnId
  agent?: AgentId
}

export interface MessageEnd {
  type: 'message_end'
  id: string
  turn_id?: TurnId
  agent?: AgentId
}

export interface ToolStart {
  type: 'tool_start'
  id: string
  name: string
  args: Record<string, unknown>
  turn_id?: TurnId
  agent?: AgentId
}

export interface ToolEnd {
  type: 'tool_end'
  id: string
  /** Free-form tool output. Render is up to the client. */
  result: unknown
  /** Set when the tool errored. */
  error?: string
  turn_id?: TurnId
  agent?: AgentId
}

export interface Status {
  type: 'status'
  value: AgentStatus
  agent?: AgentId
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
  turn_id?: TurnId
  agent?: AgentId
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
  turn_id?: TurnId
  agent?: AgentId
}

/**
 * Remove a previously rendered prompt without requiring the client to answer.
 * Useful when a mirrored approval flow times out or is resolved elsewhere.
 */
export interface PromptDismiss {
  type: 'prompt_dismiss'
  id: string
  agent?: AgentId
}

/**
 * A single slash command the agent supports.
 * Used inside `Commands` events.
 */
export interface CommandItem {
  /** Canonical name without the slash, e.g. "model" */
  name: string
  /** Human-readable description shown in the picker */
  description: string
  /** Argument placeholder shown after the name, e.g. "<prompt>" or "[on|off]" */
  args_hint?: string
  /** Grouping label, e.g. "Session", "Configuration" */
  category?: string
  /** Alternative names (shown as grey hint, not separate picker rows) */
  aliases?: string[]
  /** Tappable sub-options for commands like /reasoning, /voice */
  subcommands?: string[]
}

/**
 * Full slash command list. The adapter pushes this proactively after connecting
 * and in response to a `get_commands` request. The mobile caches it and renders
 * a "/" picker from it.
 */
export interface Commands {
  type: 'commands'
  commands: CommandItem[]
  agent?: AgentId
}

export interface PromptOption {
  /** Stable ID echoed back in PromptResponse.choice */
  id: string
  /** Display label */
  label: string
  /**
   * When true, render a text input instead of a button. The user's typed text
   * becomes the value of PromptResponse.choice (the option id is not echoed).
   */
  allowText?: boolean
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
  | Commands

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

/**
 * Request the current slash command list. The adapter responds with a `Commands`
 * event broadcast to all clients. Mobile sends this on first connect and
 * whenever the "/" picker is opened before the list has arrived.
 */
export interface GetCommands {
  type: 'get_commands'
}

export type ClientEvent = UserMessage | PromptResponse | GetCommands

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
 * Pass `turn_id` to group this message with a wider agent turn.
 */
export function textMessage(text: string, role: Role = 'assistant', turn_id?: TurnId): ServerEvent[] {
  const id = newId('msg')
  return [
    { type: 'message_start', id, role, ...(turn_id ? { turn_id } : {}) },
    { type: 'text_delta', id, text, ...(turn_id ? { turn_id } : {}) },
    { type: 'message_end', id, ...(turn_id ? { turn_id } : {}) },
  ]
}
