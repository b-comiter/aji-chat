# Claude Code Channels Integration (Mobile → Claude Code)

## Overview

The [hooks integration](claude-hooks.md) is **outbound**: it pushes Claude Code's
activity *out* to mobile. This document covers the **inbound** direction —
getting a message you type on the phone *into* a running Claude Code session.

It uses Claude Code's **[channels](https://code.claude.com/docs/en/channels.md)**
feature: an MCP server emits a `notifications/claude/channel` notification, and
Claude Code injects the body into the live session as
`<channel source="aji-chat">…</channel>`.

**Why channels (push) instead of a polling tool (pull):** push costs **zero
tokens** when nothing is happening. Nothing is injected into the context until an
actual message arrives. A polling tool would burn ~100–150 tokens on every check,
forever.

---

## Architecture

```
Phone (types a message)
      ↓ WebSocket /ws   ClientEvent: user_message { text, agent }
Aji-Chat Server (apps/server) — unchanged; forwards ClientEvents to webhooks
      ↓ HTTP POST (existing webhook dispatch)
Channel Bridge (tools/aji-channel-bridge.ts)
   • stdio MCP server spawned by Claude Code
   • tiny HTTP listener; self-registers via POST /webhook
   • forwards user_message where agent === 'claude-code'
      ↓ notifications/claude/channel
Claude Code session  →  <channel source="aji-chat">your message</channel>
```

The bridge is an **adapter**, consistent with the project philosophy: it requires
**no server changes** and reuses the existing `/webhook` mechanism.

---

## Components

| Piece | File | Role |
|---|---|---|
| Protocol field | `packages/protocol/src/index.ts` | `UserMessage.serverId?: ServerId` — routes a mobile message to a specific server |
| Mobile send | `apps/mobile/hooks/useChatActions.ts` | stamps `agent: chatId` on each `user_message` |
| Bridge | `tools/aji-channel-bridge.ts` | stdio MCP server + webhook receiver → channel notification |
| Smoke test | `tools/aji-channel-bridge.smoke.ts` | verifies routing in isolation (`pnpm channel:smoke`) |

---

## Requirements

- **Claude Code v2.1.80+** — channels are a research-preview feature that does
  not exist in earlier versions. Check with `claude --version`; upgrade with
  `claude update` if older.
- Channels work in **Claude Code only** (CLI / SDK) — **not** Claude Desktop.

## Setup

1. **Start the server** (as usual):
   ```bash
   pnpm server
   ```

2. **Register the bridge as an MCP server** for Claude Code:
   ```bash
   claude mcp add aji-chat -- pnpm --dir /Users/bcom/dev/aji-chat channel:bridge
   ```
   (or add an equivalent entry to your `.mcp.json` / `~/.claude.json`).
   Verify with `claude mcp list` — it should show `aji-chat … ✓ Connected`.

3. **Launch Claude Code with the channel loaded.** Because this is a *custom*
   channel (not on Anthropic's research-preview allowlist), it must be loaded
   with the development flag — `--channels` alone will not load it:
   ```bash
   claude --dangerously-load-development-channels server:aji-chat
   ```
   Confirm it registered as a channel by running `/mcp` in the session.

4. **Send a message from the phone.** It appears in the Claude Code session as a
   `<channel source="aji-chat">…</channel>` block, and Claude responds to it.

### Why "Connected" is not enough

`claude mcp list` showing `✓ Connected` only means the MCP subprocess started.
The channel listener is only registered when (a) the bridge declares the
`experimental: { 'claude/channel': {} }` capability — it now does — **and**
(b) the session is launched with the development flag above. Without both, the
server connects but channel notifications are dropped silently.

### Environment overrides

| Var | Default | Meaning |
|---|---|---|
| `AJI_SERVER` | `http://localhost:4000` | Base URL of the aji-chat server |
| `AJI_AGENT` | `claude-code` | Which agent this bridge represents (filters incoming messages) |

---

## Token cost

| Scenario | Cost |
|---|---|
| Session running, no mobile messages | **0 tokens** — nothing injected, no polling |
| One mobile message (~20 words) | message text + `<channel …>` wrapper ≈ **~40 tokens**, once |
| Claude's reaction | a normal turn it would have taken anyway |

---

## Routing

`UserMessage` carries an optional `agent` field (the mobile `chatId`). The bridge
forwards a message only when `agent === AJI_AGENT` (default `claude-code`). A
message with **no** `agent` is treated as a match for backward compatibility, so
older mobile builds still reach the session. This keeps Hermes-bound traffic out
of the Claude Code session when you chat with multiple agents.

---

## Limitations

- **Prompt-injection surface.** The webhook listens on `127.0.0.1` only, so
  nothing off-machine can reach it — but any local process could POST a message
  that lands in your session. Our messages come from your own phone via your own
  server, so risk is low. If you ever expose this more widely, add a sender check
  (e.g. an `X-Sender` allowlist) before emitting, per the channels-reference
  "Gate inbound messages" guidance.
- **Delivery is best-effort and unacknowledged.** `mcp.notification()` resolves
  when written to the transport, not when Claude reads it. If the session wasn't
  launched with the channel loaded, events are dropped silently. Several messages
  arriving while Claude is busy are delivered together on the next turn.
- **One-way.** Claude's reply reaches the phone via the existing outbound hook
  (`Stop` event), not a channel reply tool. To make replies flow through the
  bridge itself, add a `reply` MCP tool (see channels-reference).
- **Multiple sessions**: each Claude Code session spawns its own bridge and
  registers its own webhook, so a single mobile message is injected into *all*
  running sessions. Fine for single-session use.
- The channel must be loaded per session (development flag), and the process kept
  alive to receive events.
- On crash, the bridge may leave a stale webhook registered; the server simply
  logs a failed delivery for it until restarted. (Clean shutdown deregisters.)

## Troubleshooting

- **Nothing arrives in the session:** run `/mcp` — the bridge must show as a
  *channel*, not merely connected. If not, you launched without
  `--dangerously-load-development-channels server:aji-chat`, or Claude Code is
  older than v2.1.80.
- **"Failed to connect" in `/mcp`:** a dependency/import error in the bridge.
  Check the stderr trace at `~/.claude/debug/<session-id>.txt`.
- **Isolate the failure:** run `pnpm channel:bridge` in one terminal and
  `pnpm test:message "hi"` in another. If the bridge logs
  `forwarding user_message → hi`, the aji-chat path is fine and the problem is the
  channel handshake (version/flag).

---

## Testing

```bash
pnpm channel:smoke
```

Spawns the bridge, discovers its webhook port, and POSTs ClientEvents directly to
it — asserting that a `claude-code` (or agent-less) `user_message` is forwarded
while a `hermes` message and a non-message event are not. Requires neither the
server nor a live Claude Code session.

For a full end-to-end check, follow **Setup** above and send a message from the
phone while Claude is working; confirm the `<channel>` block appears.
