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

import asyncio
import logging
import os
import re
import uuid
from typing import Any, Optional

# Local imports
from .client import AjiClient
from .state import SessionState
from .webhook_server import WebhookServer
from ._log import flog, flog_info, flog_warn

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

# Hermes's send_progress_messages() formats tool calls as text before calling
# send() on the adapter, e.g.:
#   💻 terminal(['command'])\n{"command": "ls -la /tmp"}
# We detect this pattern and suppress it — the pre/post_tool_call hooks deliver
# the same information as structured tool_start / tool_end events.
# Pattern: <emoji(s)> <word>([...args...])\n{...json...}
_TOOL_PROGRESS_RE = re.compile(
    r"^[^\x00-\x7F]+\s+\w+\([^\)]*\)\n\{",
    re.DOTALL,
)


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
            on_get_commands=self.push_commands,
        )
        self._running = False
        # Captured in connect() once the event loop is confirmed running.
        # hooks.py reads this to submit coroutines from worker threads via
        # run_coroutine_threadsafe() instead of create_task().
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # -------------------------------------------------------------------
    # Connection lifecycle
    # -------------------------------------------------------------------

    async def connect(self) -> bool:
        flog_info("connect() called")
        # Capture the running event loop now — hooks.py needs it to submit
        # coroutines from ThreadPoolExecutor threads via run_coroutine_threadsafe.
        self._loop = asyncio.get_running_loop()
        flog_info("connect() captured event loop %s", self._loop)
        try:
            await self._webhook.start()
        except Exception as exc:
            logger.warning("aji-chat webhook listener failed to start: %s", exc)
            flog_warn("connect() webhook.start() failed: %s", exc)
            return False
        self._running = True
        flog_info("connect() webhook started at %s", self._webhook.url)
        # Register with the aji-chat server in the background so a slow or
        # not-yet-started server doesn't block gateway startup or cause
        # connect() to return False.
        asyncio.create_task(self._register_with_retry())
        return True

    async def _register_with_retry(self) -> None:
        """Keep trying to register the webhook until it succeeds or we stop."""
        delays = [1, 2, 4, 8, 16, 30]
        attempt = 0
        while self._running:
            try:
                await self._client.register_webhook(self._webhook.url)
                logger.info("aji-chat webhook registered at %s", self._webhook.url)
                flog_info("_register_with_retry() succeeded on attempt %d", attempt + 1)
                # Push the command list now that mobile can receive it.
                await self.push_commands()
                return
            except Exception as exc:
                delay = delays[min(attempt, len(delays) - 1)]
                logger.warning(
                    "aji-chat webhook registration failed (attempt %d): %s — retrying in %ds",
                    attempt + 1, exc, delay,
                )
                flog_warn("_register_with_retry() attempt %d failed: %s — retry in %ds",
                          attempt + 1, exc, delay)
                attempt += 1
                await asyncio.sleep(delay)

    async def disconnect(self) -> None:
        flog_info("disconnect() called")
        if not self._running:
            flog("disconnect() no-op (not running)")
            return
        self._running = False
        try:
            await self._client.deregister_webhook(self._webhook.url)
        finally:
            await self._webhook.stop()
            await self._client.close()
        flog_info("disconnect() complete")

    # -------------------------------------------------------------------
    # Inbound: webhook → MessageEvent → handle_message
    # -------------------------------------------------------------------

    async def _on_user_message(self, payload: dict[str, Any]) -> None:
        text = str(payload.get("text", "")).strip()
        flog("_on_user_message() text=%.120r", text)
        if not text:
            flog("_on_user_message() empty text, ignored")
            return

        # Slash commands are routed as COMMAND type so gateway/run.py dispatches
        # them through the built-in command handlers (help, model, stop, etc.)
        # rather than forwarding them to the LLM.
        msg_type = MessageType.COMMAND if text.startswith("/") else MessageType.TEXT
        flog("_on_user_message() msg_type=%s", msg_type)

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
            message_type=msg_type,
            source=source,
            message_id=uuid.uuid4().hex,
        )
        try:
            await self.handle_message(event)
        except Exception as exc:
            logger.exception("aji-chat: handle_message raised: %s", exc)

    async def push_commands(self) -> None:
        """Build the full slash command list and push a `commands` event.

        Called after the webhook registers (so mobile gets the list on first
        connect) and on demand when the mobile sends `get_commands`.

        Sources (priority order, matching Discord):
          1. COMMAND_REGISTRY built-ins (gateway-available, not cli_only)
          2. Plugin-registered commands (via ctx.register_command())

        Skills are not included here — they are handled separately as regular
        messages (the LLM routes /skill-name via skill dispatch).
        """
        commands: list[dict[str, Any]] = []

        try:
            from hermes_cli.commands import (  # type: ignore[import-not-found]
                COMMAND_REGISTRY,
                _is_gateway_available,
                _iter_plugin_command_entries,
            )

            for cmd in COMMAND_REGISTRY:
                if not _is_gateway_available(cmd):
                    continue
                entry: dict[str, Any] = {
                    "name": cmd.name,
                    "description": cmd.description,
                    "category": cmd.category,
                }
                if cmd.args_hint:
                    entry["args_hint"] = cmd.args_hint
                if cmd.aliases:
                    entry["aliases"] = list(cmd.aliases)
                if cmd.subcommands:
                    entry["subcommands"] = list(cmd.subcommands)
                commands.append(entry)

            for name, description, args_hint in _iter_plugin_command_entries():
                entry = {
                    "name": name,
                    "description": description,
                    "category": "Plugin",
                }
                if args_hint:
                    entry["args_hint"] = args_hint
                commands.append(entry)

        except Exception as exc:
            logger.warning("aji-chat: could not build command list: %s", exc)
            flog_warn("push_commands() failed to build list: %s", exc)
            return

        flog_info("push_commands() sending %d commands", len(commands))
        await self._client.emit({"type": "commands", "commands": commands})

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
        flog("send() chat_id=%s content=%.200r", chat_id, content)

        # todo: Determine if if toggable to platform-tool-progress
        if _TOOL_PROGRESS_RE.match(cleaned):
            flog("send() suppressed tool-progress text (hooks handle this)")
            return SendResult(success=True, message_id=f"msg_{uuid.uuid4().hex}")

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
        flog("edit_message() chat_id=%s msg_id=%.12s finalize=%s content=%.120r",
             chat_id, message_id, finalize, content)
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
        flog("send_typing() chat_id=%s", chat_id)
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
        flog_info("on_processing_start() chat_id=%s turn_id=%.12s", chat_id, turn_id)
        self._state.start_turn(chat_id, turn_id)
        await self._client.emit({"type": "status", "value": "thinking"})

    async def on_processing_complete(
        self, event: MessageEvent, outcome: ProcessingOutcome
    ) -> None:
        chat_id = event.source.chat_id if event.source else _DEFAULT_CHAT_ID
        flog_info("on_processing_complete() chat_id=%s outcome=%s", chat_id, outcome)
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

    @property
    def aji_loop(self) -> Optional[asyncio.AbstractEventLoop]:
        """The event loop captured at connect() time. Used by hooks.py to
        submit coroutines from ThreadPoolExecutor threads via
        run_coroutine_threadsafe()."""
        return self._loop


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
