# Agent Simulator GUI

## Current features

- Monorepo layout with `apps/mobile`, `apps/server`, `packages/protocol`, and `tools`.
- Mobile app (Expo) client and UI components under `apps/mobile`.
- `MarkdownMessage` component (`apps/mobile/components/MarkdownMessage.tsx`) that renders Markdown with syntax-highlighted code blocks, language badges, horizontal scrolling, and a Copy button for code blocks.
- Syntax highlighting using `highlight.js` with a custom `tokenColors` map and `LANG_COLORS` for language badges; handles nested spans and decodes HTML entities.
- Code block UI provided by a `CustomRenderer` (header, divider, padded code area) and `CopyButton` (copies full code block text with transient feedback).
- `normalizeNewlines` helper preserves fenced code blocks and works around React Native text nesting quirks.
- Utility scripts and hooks in `tools/` (including `tools/simulate.ts`, `tools/send.ts`, and agent hook scripts) for testing and integrating with agent adapters.
- Server implementation in `apps/server` (Hono + WebSocket) for broadcasting `ServerEvent`s to clients.
- `packages/protocol` is the single source of truth for the wire protocol types (ServerEvent / ClientEvent).
- Documentation and design notes in `docs/` and a Phase‑1 simulator mockup plan in this README (the `simulate/index.html` visual mockup file is planned but not yet created).

## Context

The existing `tools/simulate.ts` plays a single hard-coded sequence of events to test the mobile UI. To explore edge cases (different tool args, different permission option lists, sequencing, dismissing a prompt mid-flight, etc.) the developer currently has to edit code and re-run. We want an interactive HTML GUI that lets a developer compose and fire **any** ServerEvent the protocol supports — a manual driver for the same WebSocket router. It lives alongside `simulate.ts`, not replacing it.

Approach: build the visual mockup first (no network), then wire it up to the server in a follow-up. This plan covers **Phase 1: visual mockup only**.

## Phase 1: Visual mockup

### Location

- New folder: `/Users/bcom/dev/aji-chat/simulate/`
- Single file: `simulate/index.html` — self-contained HTML + CSS + JS, no build step (matches `mobile-mockup.html`'s pattern)
- Opened directly via `file://` for the visual mockup pass. Wiring up to `http://localhost:4000` happens in Phase 2.

### Design language (reuse existing system)

Copy the `:root` CSS variables and font stacks from `mobile-mockup.html`:

- Backgrounds: `--bg #0d1117`, `--surface #161b22`, `--surface-2 #1c2129`, `--surface-3 #242b35`
- Text: `--text #e6edf3`, `--text-muted #8b949e`, `--text-dim #6e7681`
- Accents: `--accent #5e8eff`, `--success #3fb950`, `--tool #b392f0`, `--warn #d29922`, `--danger #f85149`
- Body font: `-apple-system, ...`; monospace: `"SF Mono", ...`
- 14px radius default, 8px on small elements

### Layout

Two-column desktop layout (no mobile responsiveness needed — this is a developer tool):

```
┌──────────────────────────────────────────────────────────┐
│ Header: title · connection status · server URL           │
├────────────────────────────────┬─────────────────────────┤
│  Action builders (scrollable)  │  Activity log (sticky)  │
│  ─ Status                      │  timestamp · event JSON │
│  ─ Message (quick + stream)    │  ...                    │
│  ─ Tool call (start / end)     │  ...                    │
│  ─ Permission request          │                         │
│  ─ Clarify                     │                         │
│  ─ Dismiss prompt              │                         │
│  ─ Canned scenarios            │                         │
└────────────────────────────────┴─────────────────────────┘
```

### Sections to build

Each as a card matching the existing mockup style. Maps 1:1 to ServerEvent types from `packages/protocol/src/index.ts`.

| Card | Inputs | Output |
|---|---|---|
| **Status** | 3 pill buttons: `thinking` / `working` / `idle` | `Status` event |
| **Quick message** | role select (`assistant`/`user`/`system`), text area, "Send" | `MessageStart` → `TextDelta` → `MessageEnd` (one shot, via `/send` shape) |
| **Stream message** | role select, text area, char-delay number input, "Stream" | Same trio, but `TextDelta` chunked at chosen interval |
| **Tool call** | name input, args JSON textarea, "Start" / "End" buttons; sticky "active tool ID" badge once started; result JSON textarea + optional error string for End | `ToolStart` then later `ToolEnd` |
| **Permission request** | title, message, repeatable option rows (id + label, with add/remove); auto-seeds `[Allow once / Always allow / Deny]` | `PermissionRequest` event; placeholder area shows "waiting for response" (real wiring in Phase 2) |
| **Clarify** | question, repeatable choice rows | `Clarify` event |
| **Dismiss prompt** | prompt ID text input + a "pick from active prompts" dropdown | `PromptDismiss` event |
| **Canned scenarios** | List of preset buttons (e.g. "Full simulate.ts replay", "Permission deny flow", "Failing tool") | Plays a sequence |

### Activity log

Right column, sticky, monospace. Each entry: timestamp, color-coded event type badge (reuse `--tool` purple for tool events, `--accent` blue for messages, `--warn` for prompts, etc.), and the event JSON. Newest at top. "Clear" button at the top.

In Phase 1 the log is fed by the same JS that *would* call `fetch()` — every click appends the event it would have sent, so the UI feels real without making network calls.

### JS architecture (kept simple)

A single `<script>` block with:

- `events = []` — array of all events the user has triggered
- `addEvent(event)` — pushes to `events`, re-renders the log; in Phase 2 this also calls `fetch()`
- Helper builders mirroring `packages/protocol/src/index.ts`: `buildStatus(value)`, `buildMessage(role, text)`, `buildToolStart(name, args)`, etc.
- Each card's button hands its form values to a builder, then `addEvent(...)`
- ID generation: a small `newId(prefix)` helper matching the `newId` in `packages/protocol/src/index.ts`

### Wiring deferred to Phase 2

Stub a single `async function send(event) { /* TODO Phase 2 */ }` that `addEvent` calls. In Phase 2 this will `fetch('http://localhost:4000/event', { method: 'POST', body: JSON.stringify(event) })`. CORS strategy will be decided in Phase 2 (likely add Hono CORS middleware to `apps/server/src/index.ts`, since the simpler approach of file:// → localhost:4000 will be blocked).

## Files to create

- `/Users/bcom/dev/aji-chat/simulate/index.html` — the whole mockup (HTML + CSS + JS in one file, matching `mobile-mockup.html`)

## Files NOT modified in Phase 1

- `tools/simulate.ts` — left in place; will keep working
- `apps/server/src/index.ts` — untouched until Phase 2
- `packages/protocol/src/index.ts` — protocol types stay the source of truth; we don't re-export, just inline a couple of literal type values in the HTML JS for the role/status dropdowns

## Verification (Phase 1)

1. Open `simulate/index.html` directly in a browser via `file://`
2. Visual check — all sections render, dark theme matches `mobile-mockup.html`
3. Form interactions work — clicking "Send" on each card appends the correct event JSON to the activity log
4. Tool flow — clicking "Start" assigns a tool ID, the End form unlocks and uses the same ID
5. Permission/clarify option rows can be added/removed
6. Canned scenario buttons play the right sequence (just to the log)
7. No console errors

Phase 2 (separate change) will swap the stub `send()` for real `fetch()` calls and add CORS to the server.
