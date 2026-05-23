# aji-chat Hermes Plugin

A Hermes platform adapter that mirrors agent activity into the aji-chat mobile app and routes mobile-side messages back into Hermes. Lives inside the aji-chat repo so it stays in lockstep with the wire protocol.

## What you get

- **Bidirectional messaging.** Type on mobile → Hermes receives it as a user message. Hermes responds → mobile sees it stream in.
- **Structured tool cards.** Tool calls appear as discrete cards (name, args, result), not formatted text.
- **Turn grouping.** Each user turn gets a unique `turn_id` stamped on its events; the mobile UI groups them visually.
- **Approval prompts.** When Hermes needs permission, a card appears on mobile with the option buttons — tapping resolves the awaiting hook.
- **Status pill.** The mobile header shows `thinking` / `working` / `idle` based on Hermes's processing lifecycle.

## Installation

```bash
# From the aji-chat repo root:
pnpm hermes:install
```

This symlinks the plugin into `~/.hermes/plugins/aji-chat`. Re-running is idempotent. To remove:

```bash
pnpm hermes:uninstall
```

Manual fallback:

```bash
ln -s /absolute/path/to/aji-chat/tools/hermes-plugin ~/.hermes/plugins/aji-chat
```

## Configuration

Set these in `~/.hermes/.env` (Hermes loads it automatically at gateway start):

| Env var | Default | Purpose |
|---|---|---|
| `AJI_SERVER_URL` | _required_ | HTTP base URL of the aji-chat server, e.g. `http://localhost:4000` |
| `AJI_ALLOW_ALL_USERS` | _required_ | Set to `true` — aji-chat is a personal app; network access is the auth boundary |
| `AJI_PLUGIN_PORT` | `4001` | Local port the plugin's webhook listener binds to |
| `AJI_PLUGIN_HOST` | `127.0.0.1` | Interface for the webhook listener (use `0.0.0.0` if the aji-chat server runs on a different host) |
| `AJI_HOME_CHANNEL` | _optional_ | Default `chat_id` for cron delivery |

## End-to-end run

```bash
pnpm hermes:install                              # one-time
hermes plugins enable aji-chat-platform          # one-time

# Add to ~/.hermes/.env (Hermes loads this at gateway start):
#   AJI_SERVER_URL=http://localhost:4000
#   AJI_ALLOW_ALL_USERS=true

pnpm server                                       # aji-chat server on :4000
hermes gateway run                                # picks up plugin, registers webhook
# mobile app connects to ws://<host>:4000/ws
```

## Architecture

```
Mobile (apps/mobile)
   ↕  WebSocket /ws
aji-chat server (apps/server)
   ↕  HTTP — POST /event (out), POST /webhook (in)
This plugin (tools/hermes-plugin)
   ↕  in-process callbacks + plugin hooks
Hermes gateway → agent → LLM
```

**Outbound** (Hermes → mobile):
- `on_processing_start` mints a `turn_id`, emits `status:thinking`
- `pre_tool_call` hook emits `tool_start`
- `post_tool_call` hook emits `tool_end`
- `send()` emits `message_start` + `text_delta` + `message_end`
- `edit_message()` diffs against the last-sent text, emits `text_delta` for just the new characters
- `on_processing_complete` emits `status:idle`, clears `turn_id`

**Inbound** (mobile → Hermes):
- Mobile sends `user_message` over WebSocket
- aji-chat server POSTs it to the plugin's local webhook listener
- Plugin constructs a `MessageEvent`, calls `self.handle_message()` — Hermes routes to the agent

## Design notes

### No timeouts on prompts

Permission and clarify prompts emitted by the plugin **stay visible on mobile until the user taps a choice**. There is no auto-dismiss, no server-side timeout, and no `/prompt/wait` endpoint involvement.

If Hermes cancels mid-wait (e.g. user runs `/stop`), the plugin cleans up its local `pending_prompts` future and re-raises `CancelledError`. The mobile prompt stays on screen as a stale card; a tap from the user is silently dropped by the webhook listener.

Rationale: a prompt the user might not look at for an hour should still work.

### Why not `/prompt/wait`?

That endpoint exists in the aji-chat server for the Claude Code hook script, which is a short-lived process — it needs one HTTP call to block, broadcast, and return. This plugin is a long-running process, so it uses a cleaner pattern: emit the prompt as a regular `POST /event`, then `await` an `asyncio.Future` keyed by prompt id. The webhook listener receives the matching `prompt_response` and resolves the future.

### Streaming text semantics

The Hermes stream consumer calls `send()` with initial content, then `edit_message()` repeatedly with the **full accumulated text** (replace semantics, not delta semantics), and finally `edit_message(finalize=True)` when the LLM finishes. aji-chat's protocol is append-only — each `text_delta` carries only the new characters.

The adapter bridges this by keeping a `last_sent` text per `message_id` in `SessionState` and diffing each edit against it. The trailing cursor character Hermes appends during streaming (`▉` / `▍`) is stripped before diffing.

### Turn correlation

A `turn_id` (UUID) is minted in `on_processing_start` and cleared in `on_processing_complete`. All outbound events emitted during that window — text, tool calls, prompts — carry the same `turn_id`. The mobile UI uses this to visually group everything belonging to one user turn.

For events emitted outside a turn (e.g. cron-delivered messages), `turn_id` is omitted and the mobile UI just shows the message standalone.

## Open questions

These are explicitly TBD and documented for future iteration:

1. **Approval hook return contract.** `on_pre_approval` returns `{"behavior": "allow"|"deny", "choice": <option_id>}`. Whether Hermes uses one field or the other for the decision is TBD until tested. We return both for safety.
2. **Clarify tool detection.** A future enhancement could intercept `pre_tool_call` when `tool_name == "clarify"` to render a structured choice card instead of letting the question flow as a plain message. Depends on whether `register_hook` allows the hook to override the tool result.
3. **Image rendering.** `send_image` currently falls back to sending the URL/caption as text. The mobile app doesn't render images yet.

## Files

| File | Purpose |
|---|---|
| `plugin.yaml` | Hermes manifest |
| `__init__.py` | Re-exports `register` |
| `adapter.py` | `AjiChatAdapter(BasePlatformAdapter)` + `register(ctx)` |
| `client.py` | HTTP client to aji-chat server |
| `webhook_server.py` | aiohttp inbound listener |
| `state.py` | Per-chat `turn_id`, streaming `last_sent`, `pending_prompts` futures |
| `hooks.py` | `pre_tool_call`, `post_tool_call`, `pre_approval_request`, `post_approval_response` |
