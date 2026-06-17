# aji-chat

A purpose-built messaging client for chatting with AI agents (Hermes, Claude Code, and future agents). The mobile app mirrors agent output in real-time, handles tool calls and permissions, and persists conversations locally.

## Features

### Persistent Storage
- **SQLite database** (`expo-sqlite`) stores all conversations locally, indexed by agent
- Chat history loads instantly on app open; new events stream in and append live
- Conversations survive app restart — each agent has its own persistent history

### Server & Channel Navigation
- **Home screen** lists all known servers (Telegram-style rows with preview text and timestamps)
- Tap a server to see its channels; tap a channel to open the chat
- Single-channel servers (e.g. Claude Code) open their chat directly — no channel drill-down
- Add a new server with the "＋" button; channels are created from the channel list inside a server

### Local Slash Commands
- `/clear` — Delete chat history for current agent
- `/view-db` — Log database summary (agent rows + item counts) to server console as a formatted table
- `/view-chat-history [with-tools]` — Log current agent's messages to server console; use `with-tools` to include tool calls
- `/wipe-db` — Erase all conversations for all agents and return to home screen

### Markdown & Code Rendering
- Finished assistant messages render as **formatted Markdown** (tables, bold, lists, headings, links)
- **Syntax-highlighted code blocks** with language badges (Python, Rust, JavaScript, Bash, SQL, Go, etc.)
- Streaming messages show as plain text with cursor; formatting applies after `message_end`
- Code blocks scroll horizontally so wide tables don't clip

### Turn Grouping
- Events belonging to the same agent turn (user message → tool calls → assistant response) are visually linked with a left-border tint
- Works via optional `turn_id` field on all events (set by Hermes plugin or Claude Code hook)

### Event Resilience
- Defensive ordering guards handle `message_start`, `text_delta`, `message_end` arriving out of sequence
- If `text_delta` arrives before `message_start`, the message item is created on the fly
- If `message_end` arrives before other events, a placeholder is created so subsequent deltas still render correctly
- No stuck cursors or missing messages regardless of event arrival order

### Hermes Platform Integration
- Plugin at `tools/hermes-plugin/` makes Hermes a full bidirectional platform
- Messages from mobile reach Hermes; Hermes responses stream back as `text_delta` events
- Tool calls appear as structured cards in real-time
- Permission requests (approvals) render as buttons — tap to resolve and Hermes continues with your choice

### Web Compatibility
- App runs in the browser for development testing (Expo Go or web build)
- Uses platform-specific files: `DBProvider.tsx` (native with SQLite) and `DBProvider.web.tsx` (no-op mock)
- No `wa-sqlite.wasm` bundler errors on web — web has no persistence (acceptable for dev-only use)

### Architecture
- **Monorepo**: `apps/mobile` (Expo), `apps/server` (Hono + WebSocket), `packages/protocol` (wire types), `tools/` (hooks, simulators, plugins)
- **Dumb server** — broadcasts `ServerEvent`s to all clients, forwards `ClientEvent`s to webhooks. No parsing or transformation.
- **Single protocol** — all semantic meaning lives in discriminated-union `ServerEvent` and `ClientEvent` types
- **Routing fields** — optional `serverId`, `agentId`, `channel` on all events for multi-server / multi-channel delivery

## Quick Start

```bash
# Install dependencies
pnpm install

# Start server (port 4000)
pnpm server

# Start mobile app (Expo Go)
pnpm mobile

# (In another terminal) Send a test message
pnpm send "hello from the server"

# Replay a canned agent run (status, streaming text, tool, permission)
pnpm simulate

# Register Claude Code hooks (mirrors mobile permissions to desktop Claude Code)
pnpm claude-hook:install

# Install Hermes plugin (symlinks into ~/.hermes/plugins/)
pnpm hermes:install
```

Set up mobile env first: copy `apps/mobile/.env.example` to `.env` and set `EXPO_PUBLIC_SERVER_HOST` to your LAN IP.

## Remote Access (off-network)

By default, the server only listens on your LAN. Two separate tunnels are needed to use the app from mobile data:

| Tunnel | What it exposes | When needed |
|---|---|---|
| Cloudflare Tunnel | aji-chat server (port 4000) | Always — this is the app's data channel |
| `pnpm mobile --tunnel` | Expo Metro bundler | Dev builds only — not needed for standalone builds |

### 1. Generate a shared secret

```bash
openssl rand -hex 32
```

Save the output as `YOUR_TOKEN`.

### 2. Start the Cloudflare tunnel

Install `cloudflared` and run a quick tunnel (no account required, URL changes on restart):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:4000
```

For a stable URL, [create a named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) — requires a free Cloudflare account and a domain.

### 3. Start the server with the token

```bash
AJI_ACCESS_TOKEN=YOUR_TOKEN pnpm server
```

Or export it in your shell profile so it persists across restarts.

### 4. Configure the mobile app

In `apps/mobile/.env`, set the tunnel URL (include `https://` so the app uses `wss://` for WebSocket) and the token:

```bash
EXPO_PUBLIC_SERVER_HOST=https://your-tunnel-url.trycloudflare.com
EXPO_PUBLIC_SERVER_TOKEN=YOUR_TOKEN
```

Then restart Expo (`pnpm mobile`) to pick up the new env vars.

### 5. Configure agents and tools

Set `AJI_ACCESS_TOKEN` in the environment that runs each agent/tool so their HTTP posts are accepted by the server:

```bash
export AJI_ACCESS_TOKEN=YOUR_TOKEN
```

If Claude Code runs on the **same machine** as the server, leave `AJI_SERVER` at its default (`http://localhost:4000`) — the hook talks directly to localhost, not through the tunnel. If it runs on a **different machine**, also set:

```bash
export AJI_SERVER=https://your-tunnel-url.trycloudflare.com/event
export AJI_PROMPT_SERVER=https://your-tunnel-url.trycloudflare.com/prompt/wait
```

Hermes reads `AJI_ACCESS_TOKEN` automatically from the environment — no other config needed.

### 6. (Dev builds only) Tunnel the Metro bundler

```bash
pnpm mobile --tunnel
```

Expo creates its own tunnel for hot reload. Scan the new QR code it prints.

### Security notes

- `AJI_ACCESS_TOKEN` gates all server routes (HTTP and WebSocket). Do not run without it when the tunnel is active.
- Unset `AJI_ACCESS_TOKEN` for local-only development — the token is only needed when the tunnel is running.
- `/status` is intentionally exempt from auth (it only returns a connected-client count).

## iOS Builds (EAS)

Cloud builds are produced with [EAS Build](https://docs.expo.dev/build/introduction/). Run all build commands from `apps/mobile`.

### Build profiles (`apps/mobile/eas.json`)

| Profile | Distribution | Use for |
|---|---|---|
| `development` | internal, dev client | Running against the Metro dev server |
| `preview` | internal (ad-hoc) | **Installing on your own device** without the App Store |
| `production` | store | TestFlight / App Store submission |

### Get the app onto your iPhone (no App Store)

Use **internal distribution** (`preview` profile). Requires a paid **Apple Developer Program** account ($99/yr) — ad-hoc provisioning needs it. (A free account only allows USB + Xcode dev builds that expire after 7 days.)

```bash
cd apps/mobile

# 1. Register your iPhone with EAS (one-time per device)
pnpm dlx eas-cli device:create
#    → register a new device → open the URL / scan the QR on your iPhone
#    → install the provisioning profile when iOS prompts

# 2. Build for internal distribution
pnpm dlx eas-cli build --platform ios --profile preview

# 3. EAS prints a QR code + install link when done.
#    Open the link in Safari on your iPhone → tap Install.
#    The app lands on your home screen.
```

> Note: `eas build` with no `--profile` defaults to `production`, which is an App Store distribution build — it can **only** be installed via TestFlight, not sideloaded. Use `--profile preview` for direct device installs.

### Alternative: TestFlight

To share with other testers (or to use a `production` build):

```bash
pnpm dlx eas-cli submit --platform ios   # uploads to App Store Connect
```

Add testers in App Store Connect and install via the **TestFlight** app. Internal testers skip Apple review.

### Monorepo gotcha: `.easignore`

This is a pnpm monorepo, and EAS's default git-tree archiver **drops committed binary assets** (the app icon PNG, fonts) from the uploaded build — causing prebuild to fail with `ENOENT: ... aji-logo.png` even though the files are committed. The root `.easignore` fixes this: its presence switches EAS to a working-directory copy that includes the physically-present files. **Do not delete `.easignore`.**

To verify what EAS actually uploads (without running a full build):

```bash
cd apps/mobile
pnpm dlx eas-cli build:inspect --platform ios --stage archive --output /tmp/eas-archive
ls /tmp/eas-archive/apps/mobile/assets/images/   # should list aji-logo.png et al.
```

## Push Notifications

The app receives a remote push when a new message arrives while it's backgrounded or killed — so you're alerted even when aji-chat isn't open.

### How it works

```
Agent → POST /event → Server.broadcast()
                          ├─ WebSocket → live clients (in-app)
                          └─ push.observeForPush() → Expo Push API → APNs → your phone
```

- On every (re)connect the phone registers its **Expo push token** and syncs its per-server **mute** state (`register_push` + `set_mute` events).
- The server feeds every broadcast event to the push module, which decides what to deliver. All the delivery logic — which events alert, the preview text, mute filtering — lives in `apps/server/src/push.ts`, an isolated, swappable seam, so the core stays a dumb router.
- Tokens and mutes are persisted (`push_tokens.json`, `push_mutes.json`) and tokens auto-prune when Expo reports `DeviceNotRegistered` (e.g. after an uninstall).
- Delivery is outbound from the server to `exp.host`, so it works off-network too (the phone doesn't need to be reachable) — but the server **does** need outbound internet.

### WhatsApp/Telegram-style behavior

- **Title + preview** — the title is `server:channel` (the channel is always shown so you can tell conversations apart; it's omitted only when the event carries none); the body is the message itself. Streamed `text_delta`s are accumulated in the push module (keyed by message id, bounded) and sent on `message_end`, so you see the actual text, not "New message".
- **Grouping** — each push carries a `collapseId` of `serverId:channel`, so a burst of replies from one conversation collapses into a single notification that updates in place instead of a growing stack. Distinct conversations never collapse into each other. (Expo's push API has no iOS `threadId`, so `collapseId` is the supported mechanism — it shows the latest message per chat; the unread count lives on the app badge.)
- **Tap to open the chat** — each push carries `data: { serverId, channel }`; tapping it deep-links straight to that conversation (warm or cold start).
- **App-icon badge** — kept in sync with the total unread count (the same tally the home-screen pills use); cleared per-chat when you open it.
- **Smart suppression** — a push for the chat you're currently viewing is shown in-app as a chime only, not a banner.
- **Per-server mute** — the mute toggle is mirrored to the server, so muted servers don't push. Your own messages never alert.

### Setup (iOS)

1. **Requires a real build** — push does not work in Expo Go or the simulator. Use a `development` or `preview` build (see [iOS Builds](#ios-builds-eas)).
2. The `expo-notifications` config plugin (in `app.json`) adds the `aps-environment` entitlement automatically.
3. On your next `eas build`, EAS will prompt to create an **Apple Push Notifications key** (or reuse one) — accept it. This needs your Apple Developer account, which is why the account was required.
4. Launch the build and grant the notification permission prompt. The token registers automatically on connect.

### Testing it

With a real build installed and the app **backgrounded**, send a message from the server:

```bash
pnpm send "ping from the server"
```

You should get a banner notification showing the message text. Check the server log for `ws:register_push` (token received) and confirm `push_tokens.json` exists in your data dir (`~/.aji-chat/` by default). Tap the notification — it should open that exact conversation.

### Notes

- The preview body fires on **message completion** (`message_end`), so for a long streamed reply the notification lands when the message finishes, not when it starts.
- Badge counts and mute sync rely on the phone being the source of truth; the server mirrors them via `set_mute` and self-heals the full state on reconnect.

### Not yet: rich image push

Showing the image inline in the notification (`richContent: { image }`) is **not** wired up — it needs two prerequisites that don't exist yet:
1. A **publicly-reachable image URL** (files currently ride as inline base64; Expo's image field requires a URL the device can fetch). This depends on the server-hosted media transport.
2. On iOS, a **Notification Service Extension** to download + attach the image — Expo does not include one by default.

Until both exist, image messages push as a normal notification with a generic body.

## Agent Integration

### Claude Code
Hooks at `tools/claude_code_integration/claude-aji-chat-hook.ts` integrate with Claude Code's lifecycle. Hook settings are registered via `pnpm claude-hook:install` into `~/.claude/settings.json`. When Claude Code executes tools, the hook stamps `agent: 'claude-code'` on all emitted events.

### Hermes
Plugin at `tools/hermes-plugin/` enables Hermes as a platform. Install via `pnpm hermes:install`. Set `AJI_SERVER_URL=http://localhost:4000` before starting the gateway. The plugin:
- Emits `message_start` + progressive `text_delta` + `message_end` during streaming
- Handles tool calls via pre/post hooks
- Routes permission requests as modals; awaits user response
- Stamps `agent: 'hermes'` on all events

Enable streaming on aji-chat platform in `~/.hermes/config.yaml`:
```yaml
display:
  platforms:
    aji-chat:
      streaming: true
```

## Protocol

See `packages/protocol/src/index.ts` for the authoritative wire types. Key shapes:

**Server → Phone** (`ServerEvent`):
- `message_start / text_delta / message_end` — streamed assistant text
- `tool_start / tool_end` — structured tool calls with args and results
- `status` — agent state (`thinking`, `working`, `idle`)
- `permission_request / clarify` — interactive prompts
- `prompt_dismiss` — remove a prompt from mobile UI
- `commands` — slash command list for the picker
- `server_info` — server metadata (name, single-channel flag)
- `channels` — channel registry for a server (broadcast on change, replayed on connect)

**Phone → Server** (`ClientEvent`):
- `user_message` — text typed on mobile
- `user_file` — an attachment/voice clip (base64 inline)
- `prompt_response` — user's choice in a permission/clarify prompt
- `clear_channel` — reset a channel: `/clear` clears the client AND tells the agent to drop its own session for that channel
- `create_channel / delete_channel` — manage the server's channel registry
- `get_commands` — request updated command list
- `get_missed_events` — replay buffered events after a disconnect

Optional routing fields on most events:
- `turn_id?: string` — groups related events (user message + tools + response)
- `serverId?: string` — identifies the server container (`'claude-code'`, `'hermes'`, etc.)
- `agentId?: string` — server-stamped agent identity (derived from bearer token, not set by adapters)
- `channel?: string` — channel within the server; absent means `"general"`

## Development

### Type checking
```bash
pnpm --filter mobile exec tsc --noEmit
pnpm --filter server exec tsc --noEmit
```

### Inspect database
On mobile, send `/view-db` in any chat. The server logs a formatted table of all agents and per-agent item counts.

### Test out-of-order events
Mobile's event handler is defensive. Send events via `pnpm send` or the simulator in any sequence — messages still render correctly.

### Code blocks
`MarkdownMessage.tsx` uses `react-native-marked` for rendering and `highlight.js` for syntax highlighting. Language detection is automatic; `LANG_COLORS` map at the top of the component controls badge colors.

## Chat Architecture: Inverted FlatList

The mobile chat uses a **WhatsApp/iMessage-style inverted FlatList** for rendering:
- Newest messages naturally appear at the visual bottom (no sticky-bottom logic needed)
- Streaming text fills in without auto-scroll — the visual anchor stays put
- Users can scroll up to read history without being yanked back
- Scroll position is not saved; users always start at the bottom (acceptable UX trade-off matching WhatsApp/Telegram behavior)

See [`docs/chat-scroll-architecture.md`](docs/chat-scroll-architecture.md) for detailed design rationale, implementation notes, and test coverage.


## Known Limitations

- **Web**: no persistence (Hermes integration is native-only anyway)
- **Permissions**: auto-dismiss safety valve fires after 10 minutes (hardcoded in server)
- **Mobile UI**: no image rendering yet (text fallback only)
- **Streaming**: depends on Hermes config; off by default — add `streaming: true` to `display.platforms.aji-chat` in config.yaml
- **Scroll restore**: no scroll position save across sessions; users always start at the bottom of chats
