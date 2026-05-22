# aji-chat

A messaging client purpose-built for chatting with AI agents (Hermes, Claude Code, future agents). The chat surface stays conversational; tool calls live in a side pane / bottom sheet, one click away.

See [`mobile-mockup.html`](./mobile-mockup.html) for the UI direction.

## Quick start

Install dependencies from the repo root:

```bash
pnpm install
```

**Set your machine's LAN IP** (required for Expo Go on a physical device):

```bash
ipconfig getifaddr en0   # find your IP
```

Create `apps/mobile/.env` (git-ignored) from the included template:

```bash
cp apps/mobile/.env.example apps/mobile/.env
# then edit .env and set EXPO_PUBLIC_SERVER_HOST=<your IP>
```

Update `.env` any time your IP changes — no code edits needed.

Open three terminals from the repo root:

```bash
# 1 — start the WebSocket server (port 4000)
pnpm server

# 2 — start the Expo app (scan QR with Expo Go on iPhone, same Wi-Fi)
pnpm mobile

# 3 — send a plain text message to the phone
pnpm send "hello from the server"

# OR replay a full scripted agent run
pnpm simulate
```

`pnpm simulate` plays back a realistic sequence — agent status changes,
streaming text, a tool call, and a tappable permission prompt — so the mobile
UI can be developed and tested without a live agent.

## Stack at a glance

| Layer | Tech |
|---|---|
| Mobile | Expo (React Native), Expo Router, TypeScript |
| Server | Hono + `ws`, Node.js, TypeScript |
| Protocol | `@aji/protocol` — shared discriminated-union types |
| Package manager | pnpm workspaces |

## Workspace layout

```
apps/
  mobile/       Expo Go app — renders agent events, handles prompts
  server/       Hono WebSocket server — routes events to connected clients
packages/
  protocol/     Shared wire-format types (ServerEvent, ClientEvent)
tools/
  send.ts       One-liner: send a plain text message
  simulate.ts   Scripted agent-run replay
docs/
  agent-protocol.md   Protocol design notes and Hermes comparison
```

## Wire protocol

All WebSocket messages are JSON-serialised `ServerEvent` or `ClientEvent`
values defined in `packages/protocol/src/index.ts`.

**Server → phone:**

| Event | Purpose |
|---|---|
| `message_start` | Begin a new message (carries `id` and `role`) |
| `text_delta` | Append a token to the in-progress message |
| `message_end` | Finalise the message |
| `tool_start` | A tool call has begun (`name`, `args`) |
| `tool_end` | Tool finished (`result` or `error`) |
| `status` | Agent state: `thinking` \| `working` \| `idle` |
| `permission_request` | Approval prompt with labelled option buttons |
| `clarify` | Multi-choice question with labelled option buttons |

**Phone → server:**

| Event | Purpose |
|---|---|
| `user_message` | Text sent by the user |
| `prompt_response` | The user's choice for a `permission_request` or `clarify` |

See [`docs/agent-protocol.md`](./docs/agent-protocol.md) for design rationale
and a comparison with how Hermes handles the same events on Discord and
Telegram.

## Connecting a real agent

Build a `BasePlatformAdapter` in Hermes (or equivalent in another harness)
that translates the harness's internal events into the protocol types above
and sends them over WebSocket to `ws://<host>:4000/ws`. The mobile client
will handle them without any changes.

## Modularity rules

- `packages/protocol` is the single source of truth for the wire format.
  Server, mobile, and any agent adapter must import types from there — no
  inline type definitions for protocol shapes.
- The server is a dumb router: it does not parse or transform events, only
  broadcasts them to connected clients.
- Platform-specific concerns (Expo APIs, Node APIs) stay inside their
  respective `apps/` package and never leak into `packages/`.

---

## License

This project is licensed under the [MIT License](./LICENSE).
