# aji-chat

A purpose-built messaging client for chatting with AI agents (Hermes, Claude Code, and future agents). The mobile app mirrors agent output in real-time, handles tool calls and permissions, and persists conversations locally.

## Features

### Persistent Storage
- **SQLite database** (`expo-sqlite`) stores all conversations locally, indexed by agent
- Chat history loads instantly on app open; new events stream in and append live
- Conversations survive app restart — each agent has its own persistent history

### Multi-Agent Navigation
- **Home screen** lists all connected agents (Telegram-style rows with preview text and timestamps)
- Tap an agent to open its full chat history
- Connect to an agent before it starts sending events with the "＋" button (shows known agents: Claude Code, Hermes, Simulator)

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
- **Agent identity** — optional `agent?: AgentId` field on all events so mobile knows who said what

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
pnpm hooks:install

# Install Hermes plugin (symlinks into ~/.hermes/plugins/)
pnpm hermes:install
```

Set up mobile env first: copy `apps/mobile/.env.example` to `.env` and set `EXPO_PUBLIC_SERVER_HOST` to your LAN IP.

## Agent Integration

### Claude Code
Hooks at `tools/claude-aji-chat-hook.ts` integrate with Claude Code's lifecycle. Hook settings are registered via `pnpm hooks:install` into `~/.claude/settings.json`. When Claude Code executes tools, the hook stamps `agent: 'claude-code'` on all emitted events.

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

**Phone → Server** (`ClientEvent`):
- `user_message` — text typed on mobile
- `prompt_response` — user's choice in a permission/clarify prompt
- `get_commands` — request updated command list

Optional fields:
- `turn_id?: string` — groups related events (user message + tools + response)
- `agent?: AgentId` — identifies which agent sent it (added by adapter, not user)

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

## Known Limitations

- **Web**: no persistence (Hermes integration is native-only anyway)
- **Permissions**: timeout is 15 seconds (configurable via `AJI_PERMISSION_WAIT_MS` env var)
- **Mobile UI**: no image rendering yet (text fallback only)
- **Streaming**: depends on Hermes config; off by default — add `streaming: true` to `display.platforms.aji-chat` in config.yaml
