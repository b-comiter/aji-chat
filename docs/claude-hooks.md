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
   Hook Script (tools/claude_code_integration/claude-aji-chat-hook.ts)
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
| `UserPromptSubmit` | `message_start` → `text_delta` → `message_end` → `status:thinking` → `server_info` → `commands` | User's prompt is relayed to mobile (skipped when the prompt came from the phone itself); server info + command list refreshed |
| `PreToolUse` | `status:working` → `tool_start` | Tool invocation begins; `tool_use_id` preserved for pairing with `PostToolUse` |
| `PostToolUse` | `tool_end` | Tool completes with result |
| `PermissionRequest` | `permission_request` + wait up to 10 minutes for response | Permission prompt sent to both desktop and mobile |
| `Stop` | Last assistant message as `message_start/text_delta/message_end` → `status:idle` → `server_info` → `commands` | Final response extracted from transcript JSONL and sent; command list refreshed |

All events carry `serverId: 'claude-code'` and a `turn_id` shared across the entire turn. The `turn_id` is minted on `UserPromptSubmit`, written to a temp file (`/tmp/aji-turn-<session_id>`), and read back on subsequent events so the mobile UI can group them visually.

---

## Permission Request Flow (Dual-Endpoint)

When Claude Code needs a permission (e.g., "Allow read file?"):

```
Claude Code Desktop          Hook                 Server              Mobile
        │                     │                     │                   │
        ├─ PermissionRequest──>│                     │                   │
        │                     ├─ POST /prompt/wait──>│                   │
        │                     │  (up to 10 min)      ├─ broadcast ──────>│
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
        │                     │ the fetch           │                    │
        │                     │                     │  abort handler:    │
        │                     │                     │  dismissPrompt() ─>│
        │                     │                     │  (dismissed ✓)     │
```

### Observed Behavior

✅ **Mobile responds first** → `resolvePrompt()` broadcasts `prompt_dismiss`; desktop gets decision  
✅ **Desktop responds first** → Hook aborts the fetch; server abort handler cleans up the waiter and calls `dismissPrompt()`, which broadcasts `prompt_dismiss` to mobile

---

## Hook Script Details

### File: `tools/claude_code_integration/claude-aji-chat-hook.ts`

**Key variables:**
- `SERVER` (env: `AJI_SERVER`, default: `http://localhost:4000/event`) — where to POST events
- `PROMPT_SERVER` (env: `AJI_PROMPT_SERVER`, default: `http://localhost:4000/prompt/wait`) — where to wait for permission responses (server timeout: 10 minutes)

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
3. **Waits up to 10 minutes** for the user to respond on mobile (server auto-dismisses after that as a safety valve)
4. If response arrives → translates to Claude Code hook format and outputs
5. If the HTTP connection drops (e.g. desktop native dialog was used) → server abort handler cleans up the waiter

---

## Server Details

### File: `apps/server/src/index.ts`

**HTTP Endpoints (Agent-facing):**
- `POST /event` — Broadcast a single ServerEvent to all WebSocket clients
- `POST /send` — Convenience: expand plain string into message events
- `POST /prompt/wait` — Broadcast permission prompt and wait up to 10 minutes for mobile response (auto-dismisses on timeout)
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

  return new Promise((resolve) => {
    promptWaiters.set(prompt.id, { resolve })
    // Safety valve: auto-dismiss after 10 minutes so a crashed hook doesn't
    // leave a stale waiter that permanently blocks the prompt slot.
    setTimeout(() => {
      if (promptWaiters.delete(prompt.id)) {
        dismissPrompt(prompt.id)
        resolve(null)
      }
    }, 10 * 60 * 1000)
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

**Multiple active sessions:** Each Claude Code session spawns its own hook process. If two sessions are running simultaneously and the same mobile prompt ID collides (unlikely but possible), the second `prompt_response` from mobile won't find a waiter. In practice this is rare — Claude Code sessions are typically run one at a time.

---

## Installation & Usage

### Install hooks
```bash
pnpm claude-hook:install
```

This registers 4 Claude Code events in `~/.claude/settings.json` to run the hook script.

### Uninstall hooks
```bash
pnpm claude-hook:uninstall
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
- `tools/claude_code_integration/claude-aji-chat-hook.ts` — Hook implementation
- `tools/claude_code_integration/claude-hooks-install.ts` — Hook registration
- `tools/claude_code_integration/claude-hooks-uninstall.ts` — Hook cleanup
- `packages/protocol/src/index.ts` — Shared wire types
