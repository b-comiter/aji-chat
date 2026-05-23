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

### Current State (After Hook Reinstall)

When Claude Code needs a permission (e.g., "Allow read file?"):

```
Claude Code Desktop          Hook                 Server              Mobile
        │                     │                     │                   │
        ├─ PermissionRequest──>│                     │                   │
        │                     ├─ POST /prompt/wait──>│                   │
        │                     │  (timeoutMs: 5000)   ├─ broadcast ──────>│
        │                     │                     │  permission        │
        │    Shows native     │                     │                    │
        │    permission       │                     │  Shows prompt      │
        │    dialog to user   │<─ waiting ──────────┤  card to user      │
        │                     │                     │                    │
        │   [Case 1: Mobile responds first]         │                    │
        │                     │                     │<─ prompt_response──┤
        │                     │<─ response ─────────┤                    │
        │<─ decision ─────────┤                     │                    │
        │ (allow/deny)        │  ⚠️ ISSUE:         │                    │
        │ (✅ dismisses)      │  Hook does NOT     │                    │
        │                     │  cancel mobile     │ (❌ NOT dismissed) │
        │                     │                     │                    │
        │   [Case 2: Desktop responds first]        │                    │
        │                     │                     │                    │
        ├─ user chooses ─────>│                     │                    │
        │ Allow/Deny/Suggest  │                     │                    │
        │ in native dialog    │                     │                    │
        │                     │ (hook outputs       │                    │
        │                     │  decision)          │                    │
        │                     │                     │                    │
        │                     │ ⚠️ MISSING:        │                    │
        │                     │ Should call        │ (❌ still pending) │
        │                     │ /prompt/cancel     │                    │
        │                     │                     │                    │
```

### Observed Behavior

✅ **Mobile responds first** → Desktop automatically dismisses  
❌ **Desktop responds first** → Mobile stays pending (doesn't dismiss)

**Why this asymmetry?**
- When mobile responds, the server's `resolvePrompt()` function (line 48-56 in server/src/index.ts) calls `dismissPrompt()` which broadcasts `prompt_dismiss` to all clients
- When desktop responds, the hook outputs a decision but **doesn't** notify the server to cancel the mobile prompt
- Mobile has no way to know the permission was already decided on desktop

---

## Hook Script Details

### File: `tools/claude-aji-chat-hook.ts`

**Key variables:**
- `SERVER` (env: `AJI_SERVER`, default: `http://localhost:4000/event`) — where to POST events
- `PROMPT_SERVER` (env: `AJI_PROMPT_SERVER`, default: `http://localhost:4000/prompt/wait`) — where to wait for permission responses
- `PERMISSION_WAIT_MS` (env: `AJI_PERMISSION_WAIT_MS`, default: `15000`) — timeout for waiting on mobile response

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
3. **Waits for response** (default 15s, can be shortened via env var)
4. If response arrives → translates to Claude Code hook format and outputs
5. If timeout → outputs nothing, Claude Code falls back to native dialog

---

## Server Details

### File: `apps/server/src/index.ts`

**HTTP Endpoints (Agent-facing):**
- `POST /event` — Broadcast a single ServerEvent to all WebSocket clients
- `POST /send` — Convenience: expand plain string into message events
- `POST /prompt/wait` — Wait for permission response from mobile, timeout-aware
- `POST /webhook` — Register webhook URL for client events
- `DELETE /webhook` — Deregister webhook

**WebSocket Server (Phone-facing):**
- Maintains `Set<WebSocket>` of connected clients
- Broadcasts all ServerEvents to connected clients
- Receives `prompt_response` from clients and resolves waiting hook

**Permission waiting logic:**
```ts
function waitForPrompt(prompt, timeoutMs) {
  broadcast(prompt)  // Send to all clients
  
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      promptWaiters.delete(prompt.id)
      dismissPrompt(prompt.id)  // ← Broadcasts prompt_dismiss
      resolve(null)
    }, timeoutMs)
    
    promptWaiters.set(prompt.id, { resolve, timer })
  })
}
```

When mobile responds:
```ts
function resolvePrompt(event) {
  const waiter = promptWaiters.get(event.id)
  clearTimeout(waiter.timer)
  dismissPrompt(event.id)  // ← Broadcasts prompt_dismiss to all clients
  waiter.resolve(event)    // ← Resolves hook's promise
}
```

---

## Current Limitations & Next Steps

### Issue: Desktop approval doesn't dismiss mobile

**Root cause:** Hook doesn't call server to cancel the prompt when desktop approves.

**Solution:** Implement two changes:

1. **Add cancellation endpoint** on server:
   ```ts
   app.post('/prompt/cancel/:id', (c) => {
     const { id } = c.req.param()
     dismissPrompt(id)
     promptWaiters.delete(id)
     return c.json({ cancelled: true })
   })
   ```

2. **Modify hook** to call cancel after outputting decision:
   ```ts
   case 'PermissionRequest':
     const promptId = randomUUID()
     const response = await waitForPermission({ ...prompt, id: promptId })
     
     if (response) {
       writeHookJson({ hookSpecificOutput: { decision: ... } })
       // NEW: Notify server to cancel mobile prompt
       await fetch(`${SERVER.replace('/event', '')}/prompt/cancel/${promptId}`, {
         method: 'POST'
       })
     }
     break
   ```

This will make the behavior **symmetrical**: whichever endpoint responds first will dismiss the other.

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
export AJI_PERMISSION_WAIT_MS=5000  # Shorter timeout for faster desktop fallback
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
