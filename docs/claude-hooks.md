# Claude Code Hooks Integration

## Overview

The aji-chat system integrates with Claude Code Desktop via hooks—a mechanism that allows Claude Code to send lifecycle events (prompts, tool calls, permissions) to the aji-chat server, which then relays them to connected mobile clients via WebSocket.

This creates a **dual-endpoint permission system** where permission requests can be approved from either Claude Code Desktop or the mobile app, with the first responder determining the outcome.

---

## Architecture

### Components

```
Claude Code Desktop
        ↓ (hook events via stdin)
   Hook Script (tools/claude-aji-chat-hook.ts)
        ↓ (POST /event, /prompt/wait)
   Aji-Chat Server (apps/server/src/index.ts)
        ↓ (WebSocket broadcast)
   Mobile Client (apps/mobile/app/index.tsx)
```

### Data Flow

1. **User submits prompt in Claude Code** → `UserPromptSubmit` hook fires
2. **Hook translates event** → becomes aji-chat `ServerEvent` (message_start/text_delta/message_end)
3. **Hook POSTs to server** → `/event` endpoint broadcasts to all WebSocket clients
4. **Mobile receives** → renders message in UI
5. **Same for tools, status changes, and permission requests**

---

## Hook Lifecycle Events

| Claude Code Event | Aji-Chat Events | Purpose |
|---|---|---|
| `UserPromptSubmit` | `message_start` → `text_delta` → `message_end` → `status:thinking` | User's prompt is relayed to mobile |
| `PreToolUse` | `status:working` → `tool_start` | Tool invocation begins |
| `PostToolUse` | `tool_end` | Tool completes with result |
| `PermissionRequest` | `permission_request` + wait for response | Permission prompt sent to both desktop and mobile |
| `Stop` | Last assistant message as `message_start/text_delta/message_end` → `status:idle` | Assistant's final response extracted and sent |

---

## Permission Request Flow (Dual-Endpoint)

When Claude Code needs a permission (e.g., "Allow read file?"):

```
Claude Code Desktop          Hook                 Server              Mobile
        │                     │                     │                   │
        ├─ PermissionRequest──>│                     │                   │
        │                     ├─ POST /prompt/wait──>│                   │
        │                     │  (waits indefinitely)├─ broadcast ──────>│
        │                     │                     │  permission        │
        │    Shows native     │                     │                    │
        │    permission       │                     │  Shows prompt      │
        │    dialog to user   │<─ waiting ──────────┤  card to user      │
        │                     │                     │                    │
        │   [Case 1: Mobile responds first]         │                    │
        │                     │                     │<─ prompt_response──┤
        │                     │<─ response ─────────┤  resolvePrompt()   │
        │<─ decision ─────────┤                     ├─ prompt_dismiss ──>│
        │ (allow/deny)        │                     │  (dismissed ✓)     │
        │                     │                     │                    │
        │   [Case 2: Desktop responds first]        │                    │
        │                     │                     │                    │
        ├─ user chooses ─────>│                     │                    │
        │ Allow/Deny/Suggest  │ hook outputs        │                    │
        │ in native dialog    │ decision + aborts   │                    │
        │                     │ the fetch           │<── still pending ──┤
        │                     │                     │  (abort cleans up  │
        │                     │                     │   server waiter,   │
        │                     │                     │   but mobile not   │
        │                     │                     │   dismissed ⚠️)   │
```

### Observed Behavior

✅ **Mobile responds first** → `resolvePrompt()` broadcasts `prompt_dismiss`; desktop gets decision  
⚠️ **Desktop responds first** → Hook aborts the fetch; server cleans up the waiter via the abort handler; mobile prompt is **not** dismissed

**Known gap:** When desktop responds, the hook does not call `POST /prompt/cancel/:id`. The endpoint is implemented on the server — calling it after a desktop decision would make the behavior symmetrical. This is a future hook improvement.

---

## Hook Script Details

### File: `tools/claude-aji-chat-hook.ts`

**Key variables:**
- `SERVER` (env: `AJI_SERVER`, default: `http://localhost:4000/event`) — where to POST events
- `PROMPT_SERVER` (env: `AJI_PROMPT_SERVER`, default: `http://localhost:4000/prompt/wait`) — where to wait for permission responses (waits indefinitely)

**Main function:**
```ts
async function main() {
  const payload = await readStdin()  // Read hook payload from Claude Code
  const event = payload.hook_event_name  // Determine event type
  
  switch (event) {
    case 'PermissionRequest':
      const response = await waitForPermission(prompt)  // POST to /prompt/wait
      if (response) {
        writeHookJson({ hookSpecificOutput: { decision: ... } })  // Return decision to Claude Code
      }
      break
    // ... other cases
  }
}
```

**Permission handling:**
1. Builds permission options from payload
2. POSTs permission to `/prompt/wait` endpoint
3. **Waits indefinitely** for the user to respond on mobile
4. If response arrives → translates to Claude Code hook format and outputs
5. If the HTTP connection drops (e.g. desktop native dialog was used) → server abort handler cleans up the waiter

---

## Server Details

### File: `apps/server/src/index.ts`

**HTTP Endpoints (Agent-facing):**
- `POST /event` — Broadcast a single ServerEvent to all WebSocket clients
- `POST /send` — Convenience: expand plain string into message events
- `POST /prompt/wait` — Broadcast permission prompt and wait indefinitely for mobile response
- `POST /prompt/cancel/:id` — Cancel a pending prompt; dismisses it on mobile and resolves any waiting `/prompt/wait` call
- `POST /prompt/respond` — Inject a prompt response (used by the simulator UI)
- `POST /webhook` — Register webhook URL for client events
- `DELETE /webhook` — Deregister webhook
- `POST /db/dump`, `POST /chat/dump`, `POST /last-messages/dump` — Debug: receive data from mobile and print to server console
- `GET /status` — Connected client count (polled by simulator)

**WebSocket Server (Phone-facing):**
- Maintains `Set<WebSocket>` of connected clients
- Broadcasts all ServerEvents to connected clients
- Receives `prompt_response` from clients and resolves waiting hook

**Permission waiting logic:**
```ts
function waitForPrompt(prompt) {
  broadcast(prompt)  // Send to all clients

  // No timeout — waits indefinitely until mobile responds or connection drops
  return new Promise((resolve) => {
    promptWaiters.set(prompt.id, { resolve })
  })
}
```

When mobile responds:
```ts
function resolvePrompt(event) {
  const waiter = promptWaiters.get(event.id)
  promptWaiters.delete(event.id)
  dismissPrompt(event.id)  // ← Broadcasts prompt_dismiss to all clients
  waiter.resolve(event)    // ← Resolves hook's promise
}
```

---

## Known Limitation

**Desktop approval doesn't dismiss mobile.** When the desktop native dialog is used, the hook aborts the `/prompt/wait` fetch. The server's abort handler cleans up the waiter but does not call `dismissPrompt()`. To make this symmetrical, the hook should call `POST /prompt/cancel/:id` after outputting its decision — the endpoint is already implemented on the server.

---

## Installation & Usage

### Install hooks
```bash
pnpm hooks:install
```

This registers 4 Claude Code events in `~/.claude/settings.json` to run the hook script.

### Uninstall hooks
```bash
pnpm hooks:uninstall
```

Removes all aji-chat hooks from settings.

### Configuration
Set environment variables to customize behavior:
```bash
export AJI_SERVER=http://localhost:4000/event
export AJI_PROMPT_SERVER=http://localhost:4000/prompt/wait
```

### Testing
```bash
pnpm simulate
```

Runs a scripted walk-through that emits sample events with a permission prompt.

---

## Protocol Types

### Server → Client (`ServerEvent`)
- `message_start`, `text_delta`, `message_end` — Text messages
- `tool_start`, `tool_end` — Tool invocations
- `status` — Status changes (thinking, working, idle)
- `permission_request` — Permission prompt (described below)
- `clarify` — Multi-choice question
- `prompt_dismiss` — Cancel a pending prompt

### Permission Request
```ts
interface PermissionRequest {
  type: 'permission_request'
  id: string  // Unique ID for this prompt
  title: string  // e.g., "Read file permission"
  message: string  // e.g., "src/index.ts"
  options: PromptOption[]  // [{ id: 'allow_once', label: 'Allow once' }, ...]
}
```

### Client → Server (`ClientEvent`)
- `user_message` — User text input
- `prompt_response` — Response to permission/clarify prompt:
  ```ts
  interface PromptResponse {
    type: 'prompt_response'
    id: string  // Must match the prompt's ID
    choice: string  // Option ID chosen by user
  }
  ```

---

## See Also

- `docs/agent-protocol.md` — Protocol design rationale vs. Hermes
- `tools/claude-aji-chat-hook.ts` — Hook implementation
- `tools/claude-hooks-install.ts` — Hook registration
- `tools/claude-hooks-uninstall.ts` — Hook cleanup
- `packages/protocol/src/index.ts` — Shared wire types
