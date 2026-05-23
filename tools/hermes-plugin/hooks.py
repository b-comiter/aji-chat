"""
Plugin hooks — fire structured tool & approval events to aji-chat.

Hermes invokes registered hooks with `**kwargs`; the exact field names depend
on Hermes's internal call site. We code defensively: try several common
field names with fallbacks, and skip the event if essential fields aren't
available.

All hooks **filter by platform**: if the active session isn't on `aji-chat`,
the hook returns immediately so we don't broadcast events for Telegram/Discord
runs into the aji-chat mobile.

Approval hooks block on an `asyncio.Future` until the mobile user taps a
choice. There is no timeout — the prompt sits until answered or until Hermes
itself cancels the operation (CancelledError, which we let propagate after
cleaning local state).

Return-value contract for approval hooks is documented as "TBD" until tested
against a live Hermes — see README for the open question.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Optional

from . import adapter as _adapter_module

logger = logging.getLogger(__name__)

PLATFORM_NAME = "aji-chat"


# ---------------------------------------------------------------------------
# Defensive kwarg extraction
# ---------------------------------------------------------------------------

def _kwarg_first(kwargs: dict[str, Any], *names: str) -> Any:
    for n in names:
        if n in kwargs and kwargs[n] is not None:
            return kwargs[n]
    return None


def _platform_name_from_kwargs(kwargs: dict[str, Any]) -> Optional[str]:
    """Best-effort extraction of the active session's platform name."""
    # Direct field
    p = _kwarg_first(kwargs, "platform", "platform_name")
    if p is not None:
        # Could be an enum or a string
        return getattr(p, "value", None) or str(p)

    # Nested in a session-like object
    session = _kwarg_first(kwargs, "session", "session_source", "source", "ctx", "context")
    if session is not None:
        platform = getattr(session, "platform", None)
        if platform is not None:
            return getattr(platform, "value", None) or str(platform)
        # Some session objects might use platform_name string
        platform_name = getattr(session, "platform_name", None)
        if platform_name:
            return str(platform_name)

    return None


def _chat_id_from_kwargs(kwargs: dict[str, Any]) -> Optional[str]:
    cid = _kwarg_first(kwargs, "chat_id")
    if cid:
        return str(cid)
    session = _kwarg_first(kwargs, "session", "session_source", "source")
    if session is not None:
        cid = getattr(session, "chat_id", None)
        if cid:
            return str(cid)
    return None


def _is_aji_chat(kwargs: dict[str, Any]) -> bool:
    return _platform_name_from_kwargs(kwargs) == PLATFORM_NAME


def _adapter():
    """Return the live AjiChatAdapter instance or None if not connected."""
    return _adapter_module.get_current_adapter()


# ---------------------------------------------------------------------------
# Tool call hooks
# ---------------------------------------------------------------------------

async def on_pre_tool_call(**kwargs: Any) -> None:
    if not _is_aji_chat(kwargs):
        return
    adapter = _adapter()
    if adapter is None:
        return

    tool_name = str(_kwarg_first(kwargs, "tool_name", "name") or "unknown")
    tool_args = _kwarg_first(kwargs, "tool_args", "args", "arguments") or {}
    tool_id = str(_kwarg_first(kwargs, "tool_id", "tool_use_id", "call_id") or uuid.uuid4().hex)
    chat_id = _chat_id_from_kwargs(kwargs)

    try:
        await adapter.aji_client.emit(
            {
                "type": "tool_start",
                "id": tool_id,
                "name": tool_name,
                "args": tool_args if isinstance(tool_args, dict) else {"value": tool_args},
            },
            chat_id=chat_id,
        )
    except Exception as exc:
        logger.warning("aji-chat pre_tool_call emit failed: %s", exc)


async def on_post_tool_call(**kwargs: Any) -> None:
    if not _is_aji_chat(kwargs):
        return
    adapter = _adapter()
    if adapter is None:
        return

    tool_id = str(_kwarg_first(kwargs, "tool_id", "tool_use_id", "call_id") or "")
    if not tool_id:
        # Without an id, we can't pair this with a previous tool_start.
        # Skip — better to drop the event than show an orphaned tool_end.
        return

    result = _kwarg_first(kwargs, "result", "tool_result", "output")
    error = _kwarg_first(kwargs, "error", "exception")
    chat_id = _chat_id_from_kwargs(kwargs)

    event: dict[str, Any] = {"type": "tool_end", "id": tool_id, "result": result}
    if error is not None:
        event["error"] = str(error)

    try:
        await adapter.aji_client.emit(event, chat_id=chat_id)
    except Exception as exc:
        logger.warning("aji-chat post_tool_call emit failed: %s", exc)


# ---------------------------------------------------------------------------
# Approval hooks
# ---------------------------------------------------------------------------

async def on_pre_approval(**kwargs: Any) -> Any:
    """Emit a permission_request event and block on the mobile user's choice.

    Return-value contract: Hermes collects hook return values; the exact
    field shape that approval decisions take is TBD. We return a dict with
    both `behavior` (the common 'allow'/'deny' shape) and `choice` (raw
    option id) so whichever convention Hermes uses, the answer is present.
    """
    if not _is_aji_chat(kwargs):
        return None
    adapter = _adapter()
    if adapter is None:
        return None

    prompt_id = f"perm_{uuid.uuid4().hex}"
    title = str(_kwarg_first(kwargs, "title") or "Approve action")
    message = str(_kwarg_first(kwargs, "message", "description", "prompt") or "")
    chat_id = _chat_id_from_kwargs(kwargs)

    # Default option set mirrors the Claude Code hook's three-button shape.
    options = _kwarg_first(kwargs, "options")
    if not options:
        options = [
            {"id": "allow_once", "label": "Allow once"},
            {"id": "deny", "label": "Deny"},
        ]

    fut = adapter.aji_state.register_prompt(prompt_id)
    try:
        await adapter.aji_client.emit(
            {
                "type": "permission_request",
                "id": prompt_id,
                "title": title,
                "message": message,
                "options": options,
            },
            chat_id=chat_id,
        )
        choice = await fut
    except asyncio.CancelledError:
        # Hermes cancelled (e.g. /stop). Drop the state and let it propagate.
        # The mobile prompt remains visible; a stale tap will resolve nothing.
        adapter.aji_state.drop_prompt(prompt_id)
        raise
    finally:
        adapter.aji_state.drop_prompt(prompt_id)

    behavior = "allow" if choice in ("allow", "allow_once", "yes") else "deny"
    return {"behavior": behavior, "choice": choice}


async def on_post_approval(**kwargs: Any) -> None:
    # No-op: the future was already resolved by the webhook listener.
    # Included for symmetry with Hermes's hook surface.
    return None
