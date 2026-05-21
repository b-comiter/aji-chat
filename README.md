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

Create `apps/mobile/.env` (git-ignored) with:

```
EXPO_PUBLIC_SERVER_HOST=192.168.x.x
```

An `apps/mobile/.env.example` is included as a template. Update `.env` any time your IP changes.

Then open three terminals:

```bash
# 1 — start the server (port 4000)
pnpm server

# 2 — start the Expo app (scan QR with Expo Go on iPhone, same Wi-Fi)
pnpm mobile

# 3 — push a message from the server to the phone
pnpm send "hello from the server"
```

## Documentation

## Stack at a glance

## Layout

## Modularity rules

