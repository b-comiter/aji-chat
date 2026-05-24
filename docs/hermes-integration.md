# Hermes Integration

> **Status:** The platform adapter (Option D below) is implemented at
> `tools/hermes-plugin/`. See [`tools/hermes-plugin/README.md`](../tools/hermes-plugin/README.md)
> for installation and configuration. This document is preserved as a design
> reference explaining the architecture decisions and the alternatives considered.

## Overview

Hermes is a Python agent harness with a `BasePlatformAdapter` pattern. This document describes how Hermes's internal event lifecycle maps to aji-chat's wire protocol, the integration paths that were considered, and which one was implemented.

---

## How Hermes Surfaces Events Internally

Understanding the internal flow is essential before choosing an integration point.

### The Agent Loop

When a user message arrives, Hermes runs:

```
User message
    ↓
GatewayRunner._handle_message_with_agent()   [gateway/run.py]
    ↓
BasePlatformAdapter._process_message_background()
    ├── on_processing_start(event)            ← adapter hook
    ├── agent loop (conversation_loop.py)
    │   ├── LLM call
    │   ├── tool_progress_callback("tool.started", name, preview, args)
    │   ├── tool execution
    │   ├── tool_progress_callback("tool.completed", name, ..., duration, is_error)
    │   └── repeat until done
    └── on_processing_complete(event, outcome)  ← adapter hook
```

### Adapter Hooks (`BasePlatformAdapter`)

The base class exposes two programmatic lifecycle hooks — called by the harness, not the LLM:

| Hook | When it fires | Args |
|---|---|---|
| `on_processing_start(event)` | Turn begins, before any LLM call | `MessageEvent` |
| `on_processing_complete(event, outcome)` | Turn ends | `MessageEvent`, `ProcessingOutcome` (SUCCESS / FAILURE / CANCELLED) |

**Tool calls are not exposed through these hooks.** The adapter only sees the turn boundary.

### Tool Progress Callback

Tool-level events flow through a separate callback, set by the gateway per message:

```python
# gateway/run.py ~line 16324
agent.tool_progress_callback = progress_callback
```

The callback signature:

```python
def tool_progress_callback(
    event_type: str,       # "tool.started" | "tool.completed"
    tool_name: str,
    preview: str | None,   # short display string, e.g. 'search_web: "latest AI"'
    args: dict | None,
    *,
    duration: float = 0,   # only on "tool.completed"
    is_error: bool = False, # only on "tool.completed"
)
```

The gateway's default implementation queues these into a `progress_queue`, and a background async task drains the queue by calling `adapter.send()` (first tool) then `adapter.edit_message()` (subsequent tools) — resulting in a single live-updating message in Telegram/Discord rather than one message per tool.

### How Discord and Telegram Show Tool Calls

Both platforms receive tool progress as **formatted text** through the standard `send()` / `edit_message()` path — not a structured event. The message looks like:

```
🔍 search_web: "latest AI news"
📄 read_file: "config.yaml"
💾 write_file: "output.json"
```

Discord adds 👀 → ✅/❌ emoji reactions via `on_processing_start` / `on_processing_complete` for a visual status indicator.

---

## Integration Options

### Option A — Gateway Hook System (Recommended for v1)

Hermes discovers hooks from `~/.hermes/hooks/<name>/` at startup. No changes to Hermes source required. Errors in hooks are caught and logged; they never interrupt the agent.

**What you get:**

| Hook event | When | Payload |
|---|---|---|
| `agent:start` | Turn begins | `platform`, `user_id`, `chat_id`, `session_id`, `message` |
| `agent:step` | After each tool-calling iteration | `platform`, `user_id`, `session_id`, `iteration`, `tool_names`, `tools` (list with name/args/result) |
| `agent:end` | Turn ends | same as `agent:start` |

**Trade-off:** `agent:step` fires *after* a batch of tools completes — not in real-time as each tool starts. You receive all tools from a step at once, already complete. This means no in-progress spinner per tool; cards appear with args and result together.

**Hook directory layout:**

```
~/.hermes/hooks/
└── aji-chat/
    ├── HOOK.yaml
    └── handler.py
```

```yaml
# HOOK.yaml
name: aji-chat
description: Mirror Hermes events to aji-chat mobile
events: [agent:start, agent:step, agent:end]
```

```python
# handler.py
import httpx

AJI_SERVER = "http://localhost:4000"

async def handle(event_type: str, context: dict) -> None:
    if event_type == "agent:start":
        await _post("/event", {"type": "status", "value": "thinking"})

    elif event_type == "agent:step":
        for tool in context.get("tools", []):
            tool_id = tool.get("id") or tool["name"]
            await _post("/event", {
                "type": "tool_start",
                "id": tool_id,
                "name": tool["name"],
                "args": tool.get("args", {}),
            })
            await _post("/event", {
                "type": "tool_end",
                "id": tool_id,
                "result": tool.get("result"),
            })

    elif event_type == "agent:end":
        await _post("/event", {"type": "status", "value": "idle"})

async def _post(path: str, body: dict) -> None:
    try:
        async with httpx.AsyncClient() as client:
            await client.post(f"{AJI_SERVER}{path}", json=body, timeout=5)
    except Exception:
        pass  # never block the agent
```

### Option B — Plugin Hooks (Real-time tool events)

Hermes has a plugin hook system with `pre_tool_call` / `post_tool_call` hooks that fire individually per tool — giving real-time `tool.started` visibility. This is heavier to implement (requires running as a Hermes plugin rather than a gateway hook) but enables the spinner-while-in-progress UX.

Defined in `hermes_cli/plugins.py`. Deferred to a future iteration.

### Option C — `tool_progress_callback` Wrapping (Not recommended)

The gateway sets `agent.tool_progress_callback` in `run.py`. Wrapping it would give real-time structured tool events, but requires modifying `run.py` — a ~17,000-line core file — creating merge conflicts on every Hermes update.

The ACP adapter (`acp_adapter/events.py`, `make_tool_progress_cb()`) demonstrates this pattern and is a useful reference, but the gateway hook system achieves the same goal without the maintenance cost.

### Option D — `aji.py` Platform Adapter

A full `BasePlatformAdapter` subclass registered as a Hermes platform. This is the most complete integration — it handles `send()` / `edit_message()` calls directly and can override `on_processing_start` / `on_processing_complete`.

**Limitation:** `send()` receives pre-formatted text strings, not structured tool data. You would parse strings like `"🔍 search_web: \"query\""` back into structured events — fragile compared to using the hook's `tools` list.

Unless aji-chat needs to be a full conversational platform for Hermes (receiving user messages back from mobile and feeding them into the agent), a platform adapter is overkill. The hook approach is sufficient for the read-only mirroring use case.

---

## Turn Correlation

The current aji-chat protocol has no concept of a turn ID — a `tool_start` event doesn't reference the user message that triggered it. The mobile UI relies on chronological ordering.

When implementing the gateway hook, a `turn_id` can be threaded through cheaply:

```python
import uuid

_current_turn_id: str | None = None

async def handle(event_type: str, context: dict) -> None:
    global _current_turn_id

    if event_type == "agent:start":
        _current_turn_id = str(uuid.uuid4())
        # include turn_id in events once protocol supports it

    elif event_type == "agent:end":
        _current_turn_id = None
```

Adding `turn_id` to the aji-chat protocol (`tool_start`, `tool_end`, `message_start`) would let the mobile UI visually group events by turn. This requires a protocol change (minor, additive) and is the recommended approach before shipping the Hermes adapter.

---

## Text Streaming

Hermes **does** stream LLM output progressively. It connects to Claude with `streaming=True`, receives token deltas via `stream_delta_callback`, and a `stream_consumer` delivers them to the adapter as periodic `edit_message()` calls (every 0.8s or every 24 chars buffered, whichever comes first). A `▉` cursor appears on intermediate edits and is removed on the final `edit_message(finalize=True)`. Text appears word-by-word in Telegram and Discord.

The mismatch with aji-chat is **semantics, not capability**:

| | Hermes (stream consumer) | aji-chat protocol |
|---|---|---|
| Model | Replace — each `edit_message()` carries full accumulated text so far | Append — each `text_delta` carries only new characters |
| Trigger | 0.8s timer or 24-char buffer threshold | Per token |

To emit proper `text_delta` events from the platform adapter, you have two options:

1. **Diff on each edit** — in `edit_message()`, compute `new_text[len(last_sent):]` to extract the delta. Works without touching the gateway but loses tokens that arrive within the same edit window.
2. **Tap `stream_delta_callback` directly** — the gateway sets `agent.stream_delta_callback` in `run.py`. If the aji adapter registers its own callback at that point it receives actual per-token strings with no diffing needed. Requires one line in the gateway setup, not a structural change.

Option 2 is cleaner and gives true per-token fidelity matching aji-chat's `text_delta` model.

## What Hermes Does NOT Expose (at the adapter level)

- Individual tool results mid-step (only available via `tool_progress_callback` or plugin hooks, not `BasePlatformAdapter`)
- The raw LLM response object

Tool calls do not stream — they appear as structured data before/after execution via plugin hooks (Option B). Only text output streams.

---

## Recommended Path

| Goal | Approach |
|---|---|
| v1 — basic tool visibility, no gateway changes | Gateway hook (`agent:step`) |
| Real-time per-tool spinner | Plugin hooks (`pre_tool_call` / `post_tool_call`) |
| Full bidirectional (user can reply from mobile) | `aji.py` platform adapter |
| Streaming assistant text | Requires Hermes core change — deferred |

Start with the gateway hook. It requires zero Hermes source changes, installs to `~/.hermes/hooks/`, and is resilient to Hermes updates.
