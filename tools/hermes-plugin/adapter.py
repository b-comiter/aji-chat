"""
AjiChatAdapter — Hermes platform adapter that mirrors agent activity into the
aji-chat mobile app.

Maps Hermes's call surface onto aji-chat's discriminated-union ServerEvent
protocol:

  Hermes call                      | aji-chat events
  --------------------------------- | --------------------------------------
  on_processing_start(event)        | status:thinking (mints turn_id)
  send(chat_id, content)            | message_start + text_delta + message_end
  edit_message(..., finalize=False) | text_delta (delta against last_sent)
  edit_message(..., finalize=True)  | text_delta (final delta) + message_end
  on_processing_complete(...)       | status:idle (clears turn_id)
  send_typing(chat_id)              | status:working
  pre_tool_call (hook)              | tool_start
  post_tool_call (hook)             | tool_end
  pre_approval_request (hook)       | permission_request → await future → choice

Streaming details (read carefully — there are real trade-offs here):

The Hermes stream consumer calls send() first with initial content, then
edit_message() many times with the FULL ACCUMULATED text (not just deltas),
and finally edit_message(..., finalize=True) when the LLM finishes. aji-chat's
protocol is append-only: each text_delta is just the new characters. So we
keep a `last_sent` text per message_id in SessionState and diff each edit
against it to compute the incremental delta.

We choose to emit `message_end` in send() AND again in edit_message(finalize=True).
Why both?

  - Non-streaming sends (status messages, single-shot responses) only call
    send(); without message_end here, the mobile UI would show a perpetual
    streaming cursor on those.
  - Streaming sends emit a duplicate message_end at finalize, but the mobile
    handler is idempotent (it just sets done=true again).

The trade-off: during streaming, the mobile's "cursor" indicator disappears
after the initial send() because the message is marked done. Text continues
to append cleanly, just without a per-character cursor animation. The header's
status:thinking/working pill carries the "agent is working" signal in the
meantime.
"""
from __future__ import annotations

import logging
import os
import uuid
from typing import Any, Optional

# Local imports
from .client import AjiClient
from .state import SessionState
from .webhook_server import WebhookServer

# Hermes imports — resolved at runtime by the Hermes plugin loader.
# Static analysis won't find these unless the Hermes repo is on PYTHONPATH;
# that's fine, the plugin only runs inside Hermes.
from gateway.platforms.base import (  # type: ignore[import-not-found]
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
    ProcessingOutcome,
)
from gateway.config import Platform, PlatformConfig  # type: ignore[import-not-found]
from gateway.session import SessionSource  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)

# Cursor characters Hermes appends during streaming (default " ▉" per
# gateway/config.py). We strip these so they don't leak into the diff.
# Order matters: longer prefixes first.
_CURSOR_SUFFIXES = (" ▉", " ▍", "▉", "▍")

# Default identifiers for the single-user aji-chat case. The protocol carries
# chat_id but the current aji-chat server is single-tenant, so we use a stable
# constant chat_id and user_id.
_DEFAULT_CHAT_ID = "default"
_DEFAULT_USER_ID = "aji-mobile"


def _strip_cursor(text: str) -> str:
    """Remove a trailing cursor character if present. Idempotent."""
    for cursor in _CURSOR_SUFFIXES:
        if text.endswith(cursor):
            return text[: -len(cursor)]
    return text


# Module-level singleton — set in AjiChatAdapter.__init__ so the hook callbacks
# (registered before the adapter is constructed) can find the live instance.
# Hermes instantiates one adapter per platform, so a single global is correct.
_current_adapter: "Optional[AjiChatAdapter]" = None


def get_current_adapter() -> "Optional[AjiChatAdapter]":
    """Used by hooks.py to reach the live adapter's client and state."""
    return _current_adapter


class AjiChatAdapter(BasePlatformAdapter):
    """Bidirectional aji-chat ↔ Hermes adapter."""

    REQUIRES_EDIT_FINALIZE = True  # tell stream consumer to send finalize=True

    def __init__(self, config: PlatformConfig, **kwargs: Any) -> None:
        platform = Platform("aji-chat")
        super().__init__(config=config, platform=platform)
        global _current_adapter
        _current_adapter = self

        server_url = (
            os.getenv("AJI_SERVER_URL")
            or (config.extra or {}).get("server_url")
            or "http://localhost:4000"
        )
        plugin_port = int(
            os.getenv("AJI_PLUGIN_PORT")
            or (config.extra or {}).get("plugin_port")
            or 4001
        )
        plugin_host = (
            os.getenv("AJI_PLUGIN_HOST")
            or (config.extra or {}).get("plugin_host")
            or "127.0.0.1"
        )

        self._state = SessionState()
        self._client = AjiClient(server_url=server_url, state=self._state)
        self._webhook = WebhookServer(
            host=plugin_host,
            port=plugin_port,
            state=self._state,
            on_user_message=self._on_user_message,
        )
        self._running = False

    # -------------------------------------------------------------------
    # Connection lifecycle
    # -------------------------------------------------------------------

    async def connect(self) -> bool:
        try:
            await self._webhook.start()
            await self._client.register_webhook(self._webhook.url)
        except Exception as exc:
            logger.warning("aji-chat connect failed: %s", exc)
            await self._webhook.stop()
            return False
        self._running = True
        return True

    async def disconnect(self) -> None:
        if not self._running:
            return
        self._running = False
        try:
            await self._client.deregister_webhook(self._webhook.url)
        finally:
            await self._webhook.stop()
            await self._client.close()

    # -------------------------------------------------------------------
    # Inbound: webhook → MessageEvent → handle_message
    # -------------------------------------------------------------------

    async def _on_user_message(self, payload: dict[str, Any]) -> None:
        text = str(payload.get("text", "")).strip()
        if not text:
            return

        source = SessionSource(
            platform=self.platform,
            chat_id=_DEFAULT_CHAT_ID,
            chat_name="aji-chat",
            chat_type="dm",
            user_id=_DEFAULT_USER_ID,
            user_name="aji",
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=uuid.uuid4().hex,
        )
        try:
            await self.handle_message(event)
        except Exception as exc:
            logger.exception("aji-chat: handle_message raised: %s", exc)

    # -------------------------------------------------------------------
    # Outbound: send / edit_message → aji-chat events
    # -------------------------------------------------------------------

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        cleaned = _strip_cursor(content)
        message_id = f"msg_{uuid.uuid4().hex}"
        turn_id = self._state.current_turn(chat_id)

        await self._client.emit(
            {"type": "message_start", "id": message_id, "role": "assistant"},
            chat_id=chat_id, turn_id=turn_id,
        )
        if cleaned:
            await self._client.emit(
                {"type": "text_delta", "id": message_id, "text": cleaned},
                chat_id=chat_id, turn_id=turn_id,
            )
        await self._client.emit(
            {"type": "message_end", "id": message_id},
            chat_id=chat_id, turn_id=turn_id,
        )

        self._state.remember_sent(message_id, cleaned)
        return SendResult(success=True, message_id=message_id)

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        cleaned = _strip_cursor(content)
        previous = self._state.get_sent(message_id)
        turn_id = self._state.current_turn(chat_id)

        # Common case: edit text strictly extends previous; emit just the delta.
        if cleaned.startswith(previous):
            delta = cleaned[len(previous):]
        else:
            # Text was rewritten (rare — e.g. provider correction). Emit the
            # whole thing as a new delta. The mobile already has `previous`
            # rendered; this will duplicate, but correctness > minimal bytes
            # in this edge case.
            delta = cleaned

        if delta:
            await self._client.emit(
                {"type": "text_delta", "id": message_id, "text": delta},
                chat_id=chat_id, turn_id=turn_id,
            )

        self._state.remember_sent(message_id, cleaned)

        if finalize:
            await self._client.emit(
                {"type": "message_end", "id": message_id},
                chat_id=chat_id, turn_id=turn_id,
            )
            self._state.forget_sent(message_id)

        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata: Optional[dict[str, Any]] = None) -> None:
        # status events don't carry turn_id — they're terminal UI state.
        await self._client.emit({"type": "status", "value": "working"})

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        # v1: fall back to text. Mobile doesn't render images yet.
        body = caption or image_url
        return await self.send(chat_id, body, reply_to=reply_to, metadata=metadata)

    def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": "aji-chat", "type": "dm", "chat_id": chat_id}

    # -------------------------------------------------------------------
    # Turn lifecycle (status pill + turn_id minting)
    # -------------------------------------------------------------------

    async def on_processing_start(self, event: MessageEvent) -> None:
        chat_id = event.source.chat_id if event.source else _DEFAULT_CHAT_ID
        turn_id = f"turn_{uuid.uuid4().hex}"
        self._state.start_turn(chat_id, turn_id)
        await self._client.emit({"type": "status", "value": "thinking"})

    async def on_processing_complete(
        self, event: MessageEvent, outcome: ProcessingOutcome
    ) -> None:
        chat_id = event.source.chat_id if event.source else _DEFAULT_CHAT_ID
        self._state.end_turn(chat_id)
        await self._client.emit({"type": "status", "value": "idle"})

    # -------------------------------------------------------------------
    # Internal accessor for hooks.py (avoids circular import in plugin code)
    # -------------------------------------------------------------------

    @property
    def aji_state(self) -> SessionState:
        return self._state

    @property
    def aji_client(self) -> AjiClient:
        return self._client


# ---------------------------------------------------------------------------
# Standalone sender — cron delivery from a process without the live adapter
# ---------------------------------------------------------------------------

async def _standalone_send(
    pconfig: PlatformConfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[list[str]] = None,
    force_document: bool = False,
) -> dict[str, Any]:
    """One-shot POST to aji-chat's /send endpoint. Used when ``hermes cron``
    runs in a separate process and there's no in-process adapter to call."""
    import httpx

    server_url = (
        os.getenv("AJI_SERVER_URL")
        or ((pconfig.extra or {}).get("server_url"))
        or "http://localhost:4000"
    ).rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            response = await client.post(f"{server_url}/send", json={"message": message})
            response.raise_for_status()
            body = response.json()
        return {"success": True, "message_id": None, "sent_to_clients": body.get("sent", 0)}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Plugin entry point — discovered by Hermes via plugin.yaml + __init__.py
# ---------------------------------------------------------------------------

def _check_requirements() -> bool:
    """Required deps are aiohttp + httpx; both come with Hermes core, so
    this just confirms they import."""
    try:
        import aiohttp  # noqa: F401
        import httpx  # noqa: F401
        return True
    except ImportError as exc:
        logger.warning("aji-chat plugin: missing dependency: %s", exc)
        return False


def register(ctx: Any) -> None:
    # Late import keeps register() lightweight when Hermes is just scanning
    # plugins (avoids paying the hooks module's import cost unless we're
    # actually loading the platform).
    from . import hooks

    ctx.register_platform(
        name="aji-chat",
        label="Aji Chat",
        adapter_factory=lambda cfg: AjiChatAdapter(cfg),
        check_fn=_check_requirements,
        required_env=["AJI_SERVER_URL"],
        install_hint="aji-chat plugin needs AJI_SERVER_URL (e.g. http://localhost:4000)",
        standalone_sender_fn=_standalone_send,
        cron_deliver_env_var="AJI_HOME_CHANNEL",
        max_message_length=10_000,  # aji-chat has no platform-imposed limit
        emoji="📱",
        # aji-chat is a personal app — network access (same LAN) is the
        # auth boundary.  Set AJI_ALLOW_ALL_USERS=true to open the gateway.
        allow_all_env="AJI_ALLOW_ALL_USERS",
        platform_hint=(
            "You are on aji-chat mobile. Tool calls render as structured cards "
            "(name, args, result). Use plain text for the conversation; markdown "
            "is rendered as plain text on the mobile client."
        ),
    )

    # Per-tool and per-approval hooks — see hooks.py for filtering by platform.
    ctx.register_hook("pre_tool_call", hooks.on_pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.on_post_tool_call)
    ctx.register_hook("pre_approval_request", hooks.on_pre_approval)
    ctx.register_hook("post_approval_response", hooks.on_post_approval)
