# Agent Protocol: Design Notes

This document captures the research and design decisions behind the aji-chat
WebSocket message protocol. It compares how Hermes
([hermes-agent](https://github.com/NousResearch/hermes-agent)) routes agent
output to Discord and Telegram, and explains why our mobile schema diverges
from those patterns.

---

## What Hermes does

### Adapter pattern

Every platform (Discord, Telegram, Slack, etc.) implements the same abstract
`BasePlatformAdapter` interface in `gateway/platforms/base.py`. Required
methods include:

- `send()` — create a message
- `edit_message()` — modify an existing message (for streaming)
- `send_draft()` — Telegram's native animated preview (DM-only)
- `send_slash_confirm()` — three-button confirmation prompt
- `send_clarify()` — multi-choice question prompt
- `send_exec_approval()` — dangerous-command approval prompt
- `send_image()` / `send_voice()` / `send_document()` — typed media
- `send_typing()` / `stop_typing()` — typing indicators
- `get_chat_info()` — fetch chat metadata

The agent core is platform-agnostic; it hands off events to whichever adapter
matches the session's `SessionSource`.

### Streaming model

`GatewayStreamConsumer` (`gateway/stream_consumer.py`) bridges the synchronous
agent loop to async platform sends. Tokens flow into a queue; the consumer
buffers them, then progressively pushes updates via one of two transports:

1. **Edit-based** (universal): send one message, then `edit_message()` it
   repeatedly as more tokens arrive. A cursor character (`▉`) is appended
   while streaming and stripped on final edit.
2. **Draft-based** (Telegram DMs only): native animated `sendMessageDraft`
   API. Final answer is then sent as a real message.

Tuning knobs:

- `edit_interval` (~0.2s) — how often to push updates
- `buffer_threshold` (~150 chars) — minimum buffer before edit
- Adaptive backoff on flood/rate-limit errors

### Agent event types

The agent emits five categories of events through callbacks
(`acp_adapter/events.py`):

1. `tool.started` / `tool.completed` — tool call lifecycle
2. `reasoning.available` — model thinking blocks (usually dropped by gateway)
3. Streaming text deltas → buffered → message edits
4. `send_slash_confirm` / `send_clarify` / `send_exec_approval` — interactive
   prompts with buttons
5. Media (images, voice, documents) — typed per platform

### The message envelope: `SessionSource`

Every event carries routing metadata:

```python
@dataclass
class SessionSource:
    platform: Platform              # telegram, discord, etc.
    chat_id: str
    chat_type: str                  # "dm", "group", "channel", "thread"
    user_id: Optional[str]
    user_name: Optional[str]
    thread_id: Optional[str]        # forum topic / Discord thread
    guild_id: Optional[str]         # workspace scope (Discord guild)
    parent_chat_id: Optional[str]
    message_id: Optional[str]       # triggering user message (for reply threading)
    chat_topic: Optional[str]
```

The adapter knows where to deliver the response because the envelope tells it.

### Platform-specific differences

| Aspect | Discord | Telegram |
|---|---|---|
| Message length | 2000 chars (truncate) | 4096 UTF-16 units (split) |
| Length measure | `len()` codepoints | `utf16_len()` (emoji = 2 units) |
| Streaming transport | Edit-based only | Edit or native draft |
| Notifications | Notify by default | Silent by default |
| Rich formatting | Markdown (standard) | MARKDOWN_V2 (strict escaping) |
| Interactive prompts | Text fallback (no buttons) | Full inline buttons |
| Oversized text | Truncate + "..." | Split with "(1/2)" indicators |

Roughly **60% of the code** in each adapter is platform workarounds (length
limits, escaping, rate limiting, character counting, button routing). Only
~40% is core "deliver a message" logic.

---

## How aji-chat differs

We control **both ends** of the WebSocket — the server and the mobile client.
This eliminates most of the complexity Hermes carries:

- No 2000/4096-char message limits
- No rate limiting / flood control
- No MARKDOWN_V2 escaping
- No UTF-16 counting quirks
- No "edit existing message" hacks for streaming
- No platform-specific media routing

**Native streaming is trivial.** Hermes uses send-then-edit-then-edit-then-edit
because Discord and Telegram don't support real streaming. We can emit token
deltas as discrete WebSocket frames and let the client append them.

---

## Recommended aji-chat schema

Borrow Hermes's **event types and adapter pattern**, but use **append-only
deltas** instead of edit-based streaming. The shape mirrors Anthropic's
Messages API streaming events combined with Hermes's interactive prompt
vocabulary.

### Server → Phone events

Seven of the ten event types carry an optional `turn_id` that groups everything
belonging to one agent turn. The Hermes adapter mints a UUID in
`on_processing_start` and stamps it on every outbound event until
`on_processing_complete`. The Claude Code hook mints a UUID on `UserPromptSubmit`,
persists it per-session, and attaches it to all subsequent tool and message events
in that turn. If unset (e.g. from the simulator), mobile falls back to chronological ordering.

```ts
// Message lifecycle
{ type: "message_start", id: "msg_1", role: "assistant", turn_id?: "turn_abc" }
{ type: "text_delta",    id: "msg_1", text: "Hello ",    turn_id?: "turn_abc" }
{ type: "text_delta",    id: "msg_1", text: "world",     turn_id?: "turn_abc" }
{ type: "message_end",   id: "msg_1",                    turn_id?: "turn_abc" }

// Tool calls
{ type: "tool_start", id: "tool_1", name: "write_file", args: {...}, turn_id?: "turn_abc" }
{ type: "tool_end",   id: "tool_1", result: {...},                    turn_id?: "turn_abc" }

// Agent status (no turn_id — it's terminal UI state, not turn-scoped)
{ type: "status", value: "thinking" | "working" | "idle" }

// Interactive prompts
{ type: "permission_request", id: "p1", title, message, options: [...], turn_id?: "turn_abc" }
{ type: "clarify",            id: "c1", question, choices: [...],        turn_id?: "turn_abc" }
{ type: "prompt_dismiss",     id: "p1" }

// Slash command list — pushed by the agent adapter after connecting and
// on demand in response to get_commands. Mobile renders a "/" picker from it.
{ type: "commands", commands: [
    { name: "model",  description: "Switch model",  args_hint: "[model]", category: "Configuration" },
    { name: "help",   description: "Show commands",                        category: "Info" },
    ...
  ]
}
```

### Phone → Server events

```ts
{ type: "user_message",    text: "..." }          // "/" prefix routes as slash command
{ type: "prompt_response", id: "p1", choice: "once" }
{ type: "get_commands" }                           // request the slash command list
```

---

## Identifier Glossary

Every event and DB row uses identifiers with specific, distinct meanings:

| Identifier | Type | Layer | Meaning |
|---|---|---|---|
| `id` | `string` | Protocol — most events | Opaque string minted by `newId()` (format: `"msg_lk3p9q_4"`). Shared across a message triplet (`message_start` / `text_delta` / `message_end`) and a tool pair (`tool_start` / `tool_end`). Echoed back in `PromptResponse.id`. |
| `turn_id` (`TurnId`) | `string` | Protocol — optional | Groups all events from one agent turn (user prompt → tool calls → assistant reply). Hermes mints a UUID in `on_processing_start`. The Claude Code hook mints one on `UserPromptSubmit` and writes it to a temp file so subsequent `PreToolUse`, `PostToolUse`, and `Stop` events carry the same value. If unset, mobile falls back to chronological ordering. |
| `agent` (`AgentId`) | `string` | Protocol — optional | Identifies the *sending system* (`'claude-code'`, `'hermes'`, `'simulate'`). If absent, attributed to `'unknown'`. This is distinct from `chat_id` — it names who sent the event, not which conversation it belongs to. |
| `chat_id` | `string` | DB — `items.chat_id` | Foreign key into `agents.id`. Groups all messages, tool calls, and prompts under one conversation thread. Equivalent to `chat_id` in Hermes (`adapter.py`, `client.py`, `state.py`). In the current one-agent-one-chat model, `chat_id` equals the agent identity (`'claude-code'`, `'hermes'`). |
| `local_id` | `integer` | DB only | SQLite `AUTOINCREMENT` row ID in the `items` table. Never appears in the protocol or any API response — purely internal to the DB layer. |
| broadcast | _(concept)_ | Server | Every `ServerEvent` posted to `/event` is forwarded to **all** connected WebSocket clients simultaneously. No per-client routing or filtering. |

> **Hermes callers:** aji-chat's `chat_id` maps directly to Hermes's `chat_id` from `SessionSource`. The difference: in Hermes it's a platform chat identifier (e.g. a Telegram chat ID); in aji-chat it's the agent identity string. Both serve as the conversation-grouping key.

---

## Architectural takeaway

The Hermes adapter is built at `tools/hermes-plugin/` as a `BasePlatformAdapter`
subclass — the same pattern as `discord.py` and `telegram.py`. It installs as a
Hermes plugin (symlink into `~/.hermes/plugins/`), with zero changes to Hermes
core.

The schema is what any agent harness targets. Define it once in
`packages/protocol/`; every adapter — Hermes plugin, Claude Code hook script,
simulator — emits events in this format and the mobile client renders them
without modification.

### Slash commands

The Hermes adapter pushes the full slash command list as a `commands` event
after registering its webhook. The list is built from Hermes's `COMMAND_REGISTRY`
(all gateway-available built-ins) plus any plugin-registered commands. Mobile
caches the list and renders a "/" picker in the composer. Messages starting with
"/" are routed to Hermes as `MessageType.COMMAND`, which dispatches them through
the built-in command handlers (`/help`, `/model`, `/stop`, etc.) rather than
forwarding to the LLM.
