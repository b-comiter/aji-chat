"""
Plugin hooks — fire structured tool & approval events to aji-chat.

IMPORTANT: Hermes's invoke_hook() is synchronous — it calls cb(**kwargs)
and never awaits the result. All hooks registered here must be plain
(non-async) functions. Async work is submitted via run_coroutine_threadsafe()
using the event loop captured at adapter.connect() time, because hooks fire
from ThreadPoolExecutor worker threads where get_running_loop() raises.

Hook kwargs (from Hermes source):
  pre_tool_call / post_tool_call:
    tool_name, args, task_id, session_id, tool_call_id
    post_tool_call also: result, duration_ms
  pre_approval_request / post_approval_response:
    command, description, pattern_key, pattern_keys, session_key, surface
    post_approval_response also: choice
    NOTE: These hooks are observer-only — return values are ignored by
    Hermes. They cannot block or redirect the approval flow.

Platform filtering: pre/post_tool_call receive NO platform info in their
kwargs. We fall back to adapter presence — if the aji-chat adapter is
running, we're in an aji-chat session.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from . import adapter as _adapter_module
from ._log import flog, flog_warn

logger = logging.getLogger(__name__)

PLATFORM_NAME = "aji-chat"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _kwarg_first(kwargs: dict[str, Any], *names: str) -> Any:
    for n in names:
        if n in kwargs and kwargs[n] is not None:
            return kwargs[n]
    return None


def _adapter():
    return _adapter_module.get_current_adapter()

# Schedule a coroutine, handling both the main-loop and worker-thread cases.
def _schedule(coroutine, loop: "asyncio.AbstractEventLoop | None" = None) -> None:
    
    if loop is not None and loop.is_running():
        asyncio.run_coroutine_threadsafe(coroutine, loop)
        return
    
    # Fallback: if somehow we're already on the event loop (shouldn't happen
    # for tool hooks, but keeps things working for any future callers).
    try:
        asyncio.get_running_loop().create_task(coroutine)
    except RuntimeError:
        logger.debug("aji-chat hook: no running event loop, dropping event")
        flog_warn("_schedule() no event loop available — coro dropped: %s", coroutine)


# ---------------------------------------------------------------------------
# Tool call hooks  (sync wrappers — see module docstring)
# ---------------------------------------------------------------------------

def on_pre_tool_call(**kwargs: Any) -> None:
    flog("on_pre_tool_call() kwargs=%s", {k: v for k, v in kwargs.items() if k != "args"})
    adapter = _adapter()
    if adapter is None:
        flog("on_pre_tool_call() no adapter — skipped")
        return
    _schedule(_emit_tool_start(adapter, kwargs), adapter.aji_loop)


async def _emit_tool_start(adapter: Any, kwargs: dict[str, Any]) -> None:
    tool_name = str(_kwarg_first(kwargs, "tool_name", "name") or "unknown")
    tool_args = _kwarg_first(kwargs, "args", "tool_args", "arguments") or {}
    task_id = str(kwargs.get("task_id", "") or "")

    # Hermes doesn't assign tool_call_id until after the tool runs, so at
    # pre_tool_call time it's always "".  Generate our own and stash it in
    # state so _emit_tool_end can emit a matching id.
    import uuid as _uuid
    tool_id = _uuid.uuid4().hex
    if task_id:
        adapter.aji_state.store_tool_id(task_id, tool_id)
    flog("_emit_tool_start() name=%s id=%.12s task_id=%.12s args=%.120r",
         tool_name, tool_id, task_id, tool_args)

    try:
        await adapter.aji_client.emit({
            "type": "tool_start",
            "id": tool_id,
            "name": tool_name,
            "args": tool_args if isinstance(tool_args, dict) else {"value": tool_args},
        })
        flog("_emit_tool_start() emitted OK")
    except Exception as exc:
        logger.warning("aji-chat pre_tool_call emit failed: %s", exc)
        flog_warn("_emit_tool_start() emit failed: %s", exc)


def on_post_tool_call(**kwargs: Any) -> None:
    flog("on_post_tool_call() kwargs=%s", {k: v for k, v in kwargs.items()
                                           if k not in ("result", "tool_result")})
    adapter = _adapter()
    if adapter is None:
        flog("on_post_tool_call() no adapter — skipped")
        return
    _schedule(_emit_tool_end(adapter, kwargs), adapter.aji_loop)


async def _emit_tool_end(adapter: Any, kwargs: dict[str, Any]) -> None:
    task_id = str(kwargs.get("task_id", "") or "")

    # Retrieve the tool_id we generated in _emit_tool_start so the pair matches.
    # (Hermes's tool_call_id in post kwargs is the real UUID but differs from
    # the one we emitted in tool_start, since tool_call_id was "" at pre time.)
    tool_id = adapter.aji_state.pop_tool_id(task_id) if task_id else None
    if not tool_id:
        # No stored start — fall back to whatever Hermes gives us.
        tool_id = str(_kwarg_first(kwargs, "tool_call_id", "tool_id", "tool_use_id", "call_id") or "")
    if not tool_id:
        flog_warn("_emit_tool_end() no tool_id — dropped (task_id=%s keys=%s)",
                  task_id, list(kwargs.keys()))
        return

    result = _kwarg_first(kwargs, "result", "tool_result", "output")
    error = _kwarg_first(kwargs, "error", "exception")
    flog("_emit_tool_end() id=%.12s task_id=%.12s result=%.80r error=%s",
         tool_id, task_id, result, error)

    event: dict[str, Any] = {"type": "tool_end", "id": tool_id, "result": result}
    if error is not None:
        event["error"] = str(error)

    try:
        await adapter.aji_client.emit(event)
        flog("_emit_tool_end() emitted OK")
    except Exception as exc:
        logger.warning("aji-chat post_tool_call emit failed: %s", exc)
        flog_warn("_emit_tool_end() emit failed: %s", exc)


# ---------------------------------------------------------------------------
# Approval hooks  (observer-only — Hermes ignores return values)
# ---------------------------------------------------------------------------

def on_pre_approval(**kwargs: Any) -> None:
    """Emit a permission_request to mobile for visibility only.

    Hermes's pre_approval_request hook is observer-only — return values
    are discarded, so we cannot block or redirect the approval. The card
    on mobile is informational; the actual decision is made by the Hermes
    gateway's normal approval flow (CLI prompt, TUI, etc.).
    """
    flog("on_pre_approval() kwargs keys=%s", list(kwargs.keys()))
    adapter = _adapter()
    if adapter is None:
        flog("on_pre_approval() no adapter — skipped")
        return
    _schedule(_emit_approval_card(adapter, kwargs), adapter.aji_loop)


async def _emit_approval_card(adapter: Any, kwargs: dict[str, Any]) -> None:
    import uuid
    prompt_id = f"perm_{uuid.uuid4().hex}"
    command = str(_kwarg_first(kwargs, "command", "title") or "")
    description = str(_kwarg_first(kwargs, "description", "message", "prompt") or "")
    flog("_emit_approval_card() id=%s command=%.80r", prompt_id, command)

    try:
        await adapter.aji_client.emit({
            "type": "permission_request",
            "id": prompt_id,
            "title": f"Approval required: {command}" if command else "Approval required",
            "message": description,
            "options": [],  # No tappable buttons — decision is made in Hermes
        })
        flog("_emit_approval_card() emitted OK")
    except Exception as exc:
        logger.warning("aji-chat pre_approval emit failed: %s", exc)
        flog_warn("_emit_approval_card() emit failed: %s", exc)


def on_post_approval(**kwargs: Any) -> None:
    # Observer-only. Could emit a prompt_dismiss here to remove the card,
    # but we don't track the prompt_id across pre/post, so leave it for now.
    pass
