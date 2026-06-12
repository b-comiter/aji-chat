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
import json
import logging
import uuid
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


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    return str(value)


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
    # pre_tool_call time it's always "". Generate our own and stash it (with
    # the active chat_id) so _emit_tool_end can emit a matching id to the
    # correct channel.
    tool_id = uuid.uuid4().hex
    # Hooks don't receive chat_id directly — infer it from the single active
    # turn (correct for the normal single-user case; None in edge cases).
    chat_id = adapter.aji_state.active_chat_id()
    if task_id:
        adapter.aji_state.store_tool_id(task_id, tool_id, chat_id)
    flog("_emit_tool_start() name=%s id=%.12s task_id=%.12s chat_id=%s args=%.120r",
         tool_name, tool_id, task_id, chat_id, tool_args)

    try:
        await adapter.aji_client.emit(
            {
                "type": "tool_start",
                "id": tool_id,
                "name": tool_name,
                "args": _json_safe(tool_args) if isinstance(tool_args, dict) else {"value": _json_safe(tool_args)},
            },
            chat_id=chat_id,
        )
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

    # Retrieve the (tool_id, chat_id) pair we stored in _emit_tool_start so the
    # tool_end carries the same id and channel as the tool_start.
    # (Hermes's tool_call_id in post kwargs is the real UUID but differs from
    # the one we emitted in tool_start, since tool_call_id was "" at pre time.)
    tool_id, chat_id = adapter.aji_state.pop_tool_id(task_id) if task_id else (None, None)
    if not tool_id:
        # No stored start — fall back to whatever Hermes gives us (no chat_id).
        tool_id = str(_kwarg_first(kwargs, "tool_call_id", "tool_id", "tool_use_id", "call_id") or "")
        chat_id = None
    if not tool_id:
        flog_warn("_emit_tool_end() no tool_id — dropped (task_id=%s keys=%s)",
                  task_id, list(kwargs.keys()))
        return

    result = _kwarg_first(kwargs, "result", "tool_result", "output")
    error = _kwarg_first(kwargs, "error", "exception")
    flog("_emit_tool_end() id=%.12s task_id=%.12s chat_id=%s result=%.80r error=%s",
         tool_id, task_id, chat_id, result, error)

    event: dict[str, Any] = {"type": "tool_end", "id": tool_id, "result": _json_safe(result)}
    if error is not None:
        event["error"] = _json_safe(error)

    try:
        await adapter.aji_client.emit(event, chat_id=chat_id)
        flog("_emit_tool_end() emitted OK")
    except Exception as exc:
        logger.warning("aji-chat post_tool_call emit failed: %s", exc)
        flog_warn("_emit_tool_end() emit failed: %s", exc)


# ---------------------------------------------------------------------------
# Approval hooks  (observer-only — Hermes ignores return values)
# ---------------------------------------------------------------------------

def _approval_key(kwargs: dict[str, Any]) -> str:
    """Stable correlation key shared by pre/post approval hooks.
    "<session_key>:<pattern_key>" is unique enough to pair the two calls."""
    session = str(kwargs.get("session_key") or "")
    pattern = str(kwargs.get("pattern_key") or "")
    return f"{session}:{pattern}"


def on_pre_approval(**kwargs: Any) -> None:
    """Emit a permission_request card to mobile with /approve and /deny buttons.

    Hermes's pre_approval_request hook is observer-only — its return value is
    discarded, so we cannot resolve the approval from inside the hook itself.
    Instead the card's buttons are wired to the built-in /approve and /deny
    commands: tapping one sends that slash command back as a user message, which
    the gateway dispatches to resolve the pending approval — the same path the
    text-approval flow uses. on_post_approval still dismisses the card once the
    decision lands (whether it came from mobile, the CLI prompt, or the TUI).
    """
    flog("on_pre_approval() kwargs keys=%s", list(kwargs.keys()))
    adapter = _adapter()
    if adapter is None:
        flog("on_pre_approval() no adapter — skipped")
        return
    # Mark synchronously (this hook runs before Hermes sends its native approval
    # text via send()) so the adapter can suppress that redundant text prompt and
    # avoid a duplicate card. Done here rather than inside the scheduled coroutine
    # to beat any ordering race with the text send.
    adapter.aji_state.note_approval_card()
    _schedule(_emit_approval_card(adapter, kwargs), adapter.aji_loop)


async def _emit_approval_card(adapter: Any, kwargs: dict[str, Any]) -> None:
    prompt_id = f"perm_{uuid.uuid4().hex}"
    command = str(_kwarg_first(kwargs, "command", "title") or "")
    description = str(_kwarg_first(kwargs, "description", "message", "prompt") or "")
    correlation_key = _approval_key(kwargs)
    flog("_emit_approval_card() id=%s key=%s command=%.80r", prompt_id, correlation_key, command)

    # Store before emitting so on_post_approval can always find the id, even
    # if the gateway approves before our emit coroutine finishes scheduling.
    adapter.aji_state.store_approval_id(correlation_key, prompt_id)

    # Pack the command (and reason) into the message body as JSON so the mobile
    # PromptRow renders the command in a monospace code block — keeping it out of
    # the title, where a long `python3 -c "..."` one-liner is unreadable. Mirrors
    # the shape produced by the text-approval path (mobile/hooks/hermesApproval.ts)
    # so a single parser (parsePermissionMessage) handles both.
    body = json.dumps({
        **({"command": command} if command else {}),
        **({"description": description} if description else {}),
    })
    message = (
        f"Hermes is requesting permission to run a command.\n\n{body}"
        if command else description
    )

    try:
        await adapter.aji_client.emit({
            "type": "permission_request",
            "id": prompt_id,
            "title": "Approval required",
            "message": message,
            # Slash-command buttons: mobile sends these back as user messages
            # (respond() in useChatActions.ts), which the gateway routes as the
            # built-in /approve and /deny commands to resolve the pending request.
            "options": [
                {"id": "/approve", "label": "Approve once"},
                {"id": "/approve session", "label": "Approve for session"},
                {"id": "/approve always", "label": "Always approve"},
                {"id": "/deny", "label": "Deny"},
            ],
        })
        flog("_emit_approval_card() emitted OK")
    except Exception as exc:
        logger.warning("aji-chat pre_approval emit failed: %s", exc)
        flog_warn("_emit_approval_card() emit failed: %s", exc)
        # Emit failed — the card was never shown, so discard the stored id to
        # avoid a stale entry that would be popped without a matching dismiss.
        adapter.aji_state.pop_approval_id(correlation_key)


def on_post_approval(**kwargs: Any) -> None:
    """Dismiss the approval card that was shown by on_pre_approval."""
    flog("on_post_approval() kwargs keys=%s", list(kwargs.keys()))
    adapter = _adapter()
    if adapter is None:
        flog("on_post_approval() no adapter — skipped")
        return
    _schedule(_emit_approval_dismiss(adapter, kwargs), adapter.aji_loop)


async def _emit_approval_dismiss(adapter: Any, kwargs: dict[str, Any]) -> None:
    correlation_key = _approval_key(kwargs)
    prompt_id = adapter.aji_state.pop_approval_id(correlation_key)
    if not prompt_id:
        flog("_emit_approval_dismiss() no card for key=%s — nothing to dismiss", correlation_key)
        return
    flog("_emit_approval_dismiss() dismissing id=%s key=%s", prompt_id, correlation_key)
    try:
        await adapter.aji_client.emit({"type": "prompt_dismiss", "id": prompt_id})
        flog("_emit_approval_dismiss() emitted OK")
    except Exception as exc:
        logger.warning("aji-chat post_approval dismiss failed: %s", exc)
        flog_warn("_emit_approval_dismiss() emit failed: %s", exc)
