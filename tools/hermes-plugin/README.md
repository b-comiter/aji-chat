# aji-chat Hermes Plugin

A Hermes platform adapter that mirrors agent activity into the aji-chat mobile app and routes mobile-side messages back into Hermes. Lives inside the aji-chat repo so it stays in lockstep with the wire protocol.

## What you get

- **Bidirectional messaging.** Type on mobile → Hermes receives it as a user message. Hermes responds → mobile sees it stream in.
- **Slash commands.** Type `/` in the mobile composer to see a live-filtered picker of every Hermes command (`/help`, `/model`, `/stop`, `/new`, …) and any plugin-registered commands. Selecting one fills the composer; sending routes it through Hermes's built-in command dispatch rather than the LLM.
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
- Mobile sends `user_message` over WebSocket; aji-chat server forwards it to the plugin's webhook listener
- If text starts with `/`, the plugin sets `MessageType.COMMAND` — Hermes dispatches through its built-in command handlers
- Otherwise the plugin constructs a `MessageType.TEXT` event and calls `self.handle_message()` — Hermes routes to the agent
- Mobile sends `get_commands` on connect; the plugin responds with the full `commands` event (built from `COMMAND_REGISTRY` + plugin commands)

## Design notes

### Tool hooks and the event loop

Hermes's `invoke_hook()` is synchronous and fires tool hooks from a
`ThreadPoolExecutor` thread — not the main asyncio event loop. The plugin
captures the running event loop in `connect()` (`asyncio.get_running_loop()`)
and uses `asyncio.run_coroutine_threadsafe(coro, loop)` to schedule hook
coroutines safely from those threads. This is the correct cross-thread primitive;
`create_task()` would silently fail with `RuntimeError: no running event loop`.

Hermes does not assign `tool_call_id` until after a tool runs, so the value is
always `""` at `pre_tool_call` time. The plugin generates its own UUID for each
`tool_start`, stores it in `SessionState.pending_tool_ids[task_id]`, and
retrieves it in `post_tool_call` so `tool_start` and `tool_end` carry matching
IDs and mobile can pair them.

### Tool progress text suppression

Hermes also calls `send()` with a formatted text representation of each tool
call (e.g. `💻 terminal(['command'])\n{...json...}`), produced by
`send_progress_messages()` in `gateway/run.py` for text-only platforms like
Telegram. The plugin detects this pattern and suppresses it — the hook path
already delivers the same information as structured `tool_start` / `tool_end`
events. The detection regex matches `{emoji} {name}([args])\n{json}` at the
start of the content.

### Slash commands

`push_commands()` is called after the webhook registers and in response to
`get_commands` ClientEvents. It queries `COMMAND_REGISTRY` (filtered to
gateway-available commands) and `_iter_plugin_command_entries()`, serialises
them into `CommandItem` objects, and broadcasts a `commands` event. Mobile
caches the list and shows a live-filtered picker when the user types `/`.
Messages starting with `/` are routed as `MessageType.COMMAND` so Hermes's
built-in dispatch handles them — they never reach the LLM.

Adapter-owned command:
- `/stream on|off` updates `display.platforms.aji-chat.streaming` in
   `~/.hermes/config.yaml` via `hermes config set ...`.
- After changing it, restart the Hermes gateway for the setting to take effect.

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

## Debugging

The plugin writes detailed logs to `~/Desktop/hermes-aji.log` — every method
call, every event emitted, every hook firing. Useful when diagnosing why a tool
card or command isn't appearing on mobile:

```bash
tail -f ~/Desktop/hermes-aji.log
```

The logger (`aji_chat_plugin`) is isolated from Hermes's own log stream
(`propagate=False`), so it never pollutes the gateway console output.

## Open questions / future work

1. **Clarify tool detection.** A future enhancement could intercept
   `pre_tool_call` when `tool_name == "clarify"` to render a structured choice
   card instead of letting the question flow as a plain message. Depends on
   whether `register_hook` allows the hook to override the tool result.
2. **Inline image rendering.** Local files all flow through `_emit_file` →
   `file` events: `send_voice`/`send_video`/`send_document`/`send_image_file`
   read the file, base64-encode it, and emit it (Ogg/Opus audio is transcoded
   to m4a/AAC first via ffmpeg, since iOS can't decode Ogg). The mobile renders
   `audio/*` with a player and everything else as a tappable file chip — it does
   not yet render images *inline*, so URL-based `send_image` still falls back to
   text (a link reads better than a chip). Inline image previews are the
   remaining gap.
3. **Skill commands in the picker.** `push_commands()` currently includes only
   `COMMAND_REGISTRY` built-ins and plugin-registered commands. Skills (e.g.
   `/code-review`) are reachable by typing but don't appear in the `/` picker.
   Adding them requires querying `get_skill_commands()` — straightforward but
   deferred to avoid a long startup scan.

## Files

| File | Purpose |
|---|---|
| `plugin.yaml` | Hermes manifest |
| `__init__.py` | Re-exports `register`; initialises the file logger |
| `adapter.py` | `AjiChatAdapter(BasePlatformAdapter)` + `register(ctx)` |
| `client.py` | HTTP client to aji-chat server (`POST /event`, `/webhook`) |
| `webhook_server.py` | aiohttp inbound listener (`/inbound`) |
| `state.py` | Per-chat `turn_id`, streaming `last_sent`, `pending_prompts` futures, `pending_tool_ids` |
| `hooks.py` | `pre_tool_call`, `post_tool_call`, `pre_approval_request`, `post_approval_response` |
| `_log.py` | Shared file logger → `~/Desktop/hermes-aji.log` |
