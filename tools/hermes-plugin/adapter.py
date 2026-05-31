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
  send_voice / send_video /         | file (base64 inline, mime by extension)
    send_document / send_image_file |
  pre_tool_call (hook)              | tool_start
  post_tool_call (hook)             | tool_end
  pre_approval_request (hook)       | permission_request → await future → choice

Media (the send_* file methods) all funnel through `_emit_file`, which reads
the local file, base64-encodes it, and emits one `file` event. Ogg/Opus audio
(Hermes TTS's default) is transcoded to m4a/AAC first because iOS/AVFoundation
can't decode Ogg; the mobile renders `audio/*` as a player and everything else
as a file chip.

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
import base64
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
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
_STREAMING_CONFIG_KEY = "display.platforms.aji-chat.streaming"

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
        self._last_status: str = ""
        # message_id -> (chat_id, turn_id) for open messages tracked in state.last_sent.
        self._open_message_scope: dict[str, tuple[str, Optional[str]]] = {}
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
        # Start the registration monitor in the background. It handles the
        # initial registration (with backoff) and keeps the webhook alive
        # across aji-chat server restarts.
        asyncio.create_task(self._registration_monitor())
        return True

    async def _registration_monitor(self) -> None:
        """Register the webhook and keep it alive across aji-chat server restarts.

        Uses GET /status as the liveness probe (cheap, no server-log noise).
        POST /webhook is only sent when the connection is first established or
        restored after an outage — not on every poll. When the server comes
        back after a restart its webhook registry is cleared, so we re-register
        and re-push commands so mobile gets a fresh list.
        """
        _RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30]
        _POLL_INTERVAL = 300

        registered = False
        attempt = 0

        while self._running:
            try:
                await self._client.probe()  # lightweight: GET /status
                if not registered:
                    await self._client.register_webhook(self._webhook.url)
                    registered = True
                    attempt = 0
                    logger.info("aji-chat webhook registered at %s", self._webhook.url)
                    flog_info("_registration_monitor() registered")
                    await self.push_commands()
                await asyncio.sleep(_POLL_INTERVAL)
            except Exception as exc:
                if registered:
                    logger.warning("aji-chat: server unreachable, will re-register on reconnect: %s", exc)
                    flog_warn("_registration_monitor() lost server: %s", exc)
                    registered = False
                delay = _RECONNECT_DELAYS[min(attempt, len(_RECONNECT_DELAYS) - 1)]
                flog_warn("_registration_monitor() retry in %ds (attempt %d): %s", delay, attempt + 1, exc)
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

        # Adapter-owned command for toggling Hermes display streaming on this platform.
        # We handle it locally so mobile can flip the setting without routing to the LLM.
        if text.startswith("/stream"):
            await self._handle_stream_command(_DEFAULT_CHAT_ID, text)
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

    async def _handle_stream_command(self, chat_id: str, text: str) -> None:
        parts = text.split()
        if len(parts) != 2:
            await self._send_one_shot_message(chat_id, "Usage: /stream <on|off>")
            return

        arg = parts[1].lower()
        if arg in ("on", "true", "1"):
            enabled = True
        elif arg in ("off", "false", "0"):
            enabled = False
        else:
            await self._send_one_shot_message(chat_id, "Usage: /stream <on|off>")
            return

        ok, detail = await _set_platform_streaming(enabled)
        if not ok:
            await self._send_one_shot_message(chat_id, f"Failed to set streaming: {detail}")
            return

        state = "enabled" if enabled else "disabled"
        await self._send_one_shot_message(
            chat_id,
            f"Streaming {state} for aji-chat. Restart Hermes gateway to apply.",
        )

    async def _send_one_shot_message(self, chat_id: str, content: str) -> None:
        """Emit one complete assistant message (start + optional delta + end).

        Use this for adapter-local responses that should never enter Hermes's
        stream/edit lifecycle.
        """
        cleaned = _strip_cursor(content)
        message_id = f"msg_{uuid.uuid4().hex}"
        turn_id = self._state.current_turn(chat_id)

        await self._client.emit(
            {"type": "message_start", "id": message_id, "role": "assistant"},
            chat_id=chat_id,
            turn_id=turn_id,
        )
        if cleaned:
            await self._client.emit(
                {"type": "text_delta", "id": message_id, "text": cleaned},
                chat_id=chat_id,
                turn_id=turn_id,
            )
        await self._client.emit(
            {"type": "message_end", "id": message_id},
            chat_id=chat_id,
            turn_id=turn_id,
        )

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

            # Adapter-owned command (processed in _on_user_message).
            if not any(c.get("name") == "stream" for c in commands):
                commands.append({
                    "name": "stream",
                    "description": "Toggle aji-chat streaming display mode",
                    "category": "Plugin",
                    "args_hint": "<on|off>",
                })

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
        self._state.remember_sent(message_id, cleaned)
        self._open_message_scope[message_id] = (chat_id, turn_id)
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

        if finalize and not self._state.is_tracked(message_id):
            flog("edit_message() skipping redundant finalize for already-closed msg=%.12s", message_id)
            return SendResult(success=True, message_id=message_id)

        previous = self._state.get_sent(message_id)
        turn_id = self._state.current_turn(chat_id)

        # Compute the incremental delta to emit.
        # Agents may call edit_message in two modes:
        #   A. Buffered — each call has the complete text so far;
        #      delta = new suffix (cleaned[len(previous):]).
        #   B. Streaming — each call has only the new token;
        #      startswith check fails, so we treat content as the delta.
        # In both cases we store the running total (previous + delta) so the
        # next call — including the final finalize call — always sees the full
        # accumulated text and computes an empty or correct delta.
        if cleaned.startswith(previous):
            delta = cleaned[len(previous):]
        else:
            delta = cleaned
        self._state.remember_sent(message_id, previous + delta)

        if delta:
            await self._client.emit(
                {"type": "text_delta", "id": message_id, "text": delta},
                chat_id=chat_id, turn_id=turn_id,
            )

        if finalize:
            await self._client.emit(
                {"type": "message_end", "id": message_id},
                chat_id=chat_id, turn_id=turn_id,
            )
            self._state.forget_sent(message_id)
            self._open_message_scope.pop(message_id, None)

        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata: Optional[dict[str, Any]] = None) -> None:
        flog("send_typing() chat_id=%s", chat_id)
        await self._emit_status("working")

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        # URL-based images stay text for now — mobile renders local files as a
        # chip, not inline images, so a tappable link reads better. Local image
        # files arrive via send_image_file below and become `file` events.
        body = caption or image_url
        return await self.send(chat_id, body, reply_to=reply_to, metadata=metadata)

    # -------------------------------------------------------------------
    # Outbound media: typed Hermes file methods → one `file` event each
    # -------------------------------------------------------------------

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs: Any,
    ) -> SendResult:
        flog("send_voice() chat_id=%s path=%r", chat_id, audio_path)
        return await self._emit_file(chat_id, audio_path, caption=caption, reply_to=reply_to)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs: Any,
    ) -> SendResult:
        flog("send_video() chat_id=%s path=%r", chat_id, video_path)
        return await self._emit_file(chat_id, video_path, caption=caption, reply_to=reply_to)

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs: Any,
    ) -> SendResult:
        flog("send_document() chat_id=%s path=%r name=%s", chat_id, file_path, file_name)
        return await self._emit_file(chat_id, file_path, caption=caption, name=file_name, reply_to=reply_to)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs: Any,
    ) -> SendResult:
        flog("send_image_file() chat_id=%s path=%r", chat_id, image_path)
        return await self._emit_file(chat_id, image_path, caption=caption, reply_to=reply_to)

    async def _emit_file(
        self,
        chat_id: str,
        path: str,
        *,
        caption: Optional[str] = None,
        name: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """Read a local file, base64-encode it, and emit one `file` event.

        Ogg/Opus audio is transcoded to m4a/AAC first (iOS can't decode Ogg).
        Never raises — a delivery failure must not break the agent, mirroring
        the rest of this adapter and the Claude Code hook philosophy.
        """
        if not path or not os.path.exists(path):
            flog_warn("_emit_file() missing path=%r", path)
            return SendResult(success=False, error=f"File not found: {path}")

        src_path = path
        cleanup_path: Optional[str] = None
        mime = _guess_mime(path)
        display_name = name or os.path.basename(path)

        # Transcode iOS-incompatible audio (Ogg/Opus) to m4a so the clip plays
        # on both iOS and Android. Falls back to the original if ffmpeg is absent.
        if os.path.splitext(path)[1].lower() in _IOS_INCOMPATIBLE_AUDIO_EXTS:
            transcoded = await _transcode_ogg_to_m4a(path)
            if transcoded:
                src_path = transcoded
                cleanup_path = transcoded
                mime = "audio/mp4"
                display_name = os.path.splitext(display_name)[0] + ".m4a"
            else:
                flog_warn("_emit_file() no transcode for %s — iOS won't decode it", path)

        try:
            with open(src_path, "rb") as fh:
                raw = fh.read()
            data_b64 = base64.b64encode(raw).decode("ascii")
            duration = await _probe_duration_seconds(src_path)

            file_id = f"file_{uuid.uuid4().hex}"
            turn_id = self._state.current_turn(chat_id)
            event: dict[str, Any] = {
                "type": "file",
                "id": file_id,
                "role": "assistant",
                "mime": mime,
                "data": data_b64,
                "name": display_name,
            }
            if duration is not None:
                event["duration"] = duration
            if caption:
                event["text"] = caption

            await self._client.emit(event, chat_id=chat_id, turn_id=turn_id)
            flog_info("_emit_file() sent name=%s mime=%s bytes=%d dur=%s",
                      display_name, mime, len(raw), duration)
            return SendResult(success=True, message_id=file_id)
        except Exception as exc:
            flog_warn("_emit_file() failed path=%r: %s", path, exc)
            return SendResult(success=False, error=str(exc))
        finally:
            if cleanup_path:
                try:
                    os.unlink(cleanup_path)
                except OSError:
                    pass

    def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": "aji-chat", "type": "dm", "chat_id": chat_id}

    # -------------------------------------------------------------------
    # Turn lifecycle (status pill + turn_id minting)
    # -------------------------------------------------------------------

    async def _emit_status(self, value: str) -> None:
        """Emit a status event, skipping the round-trip when value hasn't changed."""
        if self._last_status == value:
            flog("_emit_status() skipped duplicate value=%s", value)
            return
        self._last_status = value
        await self._client.emit({"type": "status", "value": value})

    async def on_processing_start(self, event: MessageEvent) -> None:
        chat_id = event.source.chat_id if event.source else _DEFAULT_CHAT_ID
        turn_id = f"turn_{uuid.uuid4().hex}"
        flog_info("on_processing_start() chat_id=%s turn_id=%.12s", chat_id, turn_id)
        self._state.start_turn(chat_id, turn_id)
        await self._emit_status("thinking")

    async def on_processing_complete(
        self, event: MessageEvent, outcome: ProcessingOutcome
    ) -> None:
        chat_id = event.source.chat_id if event.source else _DEFAULT_CHAT_ID
        flog_info("on_processing_complete() chat_id=%s outcome=%s", chat_id, outcome)

        # Close only messages opened for this chat/turn that were never finalized
        # by edit_message(finalize=True) — i.e. non-streaming single responses.
        # Streaming responses call forget_sent() inside edit_message(finalize=True)
        # so their IDs are already gone by the time we reach here.
        turn_id = self._state.current_turn(chat_id)
        for message_id in list(self._state.last_sent.keys()):
            scope = self._open_message_scope.get(message_id)
            if scope is None:
                # Unknown scope: do not risk closing a message from another chat.
                flog_warn("on_processing_complete() missing scope for message %s; skipped", message_id)
                continue
            msg_chat_id, msg_turn_id = scope
            if msg_chat_id != chat_id or msg_turn_id != turn_id:
                continue

            flog_info("on_processing_complete() closing open message %s", message_id)
            await self._client.emit(
                {"type": "message_end", "id": message_id},
                chat_id=chat_id, turn_id=turn_id,
            )
            self._state.forget_sent(message_id)
            self._open_message_scope.pop(message_id, None)

        self._state.end_turn(chat_id)
        await self._emit_status("idle")

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
# Media helpers — mime guessing, duration probing, Ogg→m4a transcode
# ---------------------------------------------------------------------------

# Audio Hermes TTS emits by default but iOS/AVFoundation can't decode. We
# transcode these to m4a/AAC, which plays on both iOS and Android.
_IOS_INCOMPATIBLE_AUDIO_EXTS = {".ogg", ".opus", ".oga"}


def _guess_mime(path: str, fallback: str = "application/octet-stream") -> str:
    mime, _ = mimetypes.guess_type(path)
    return mime or fallback


async def _set_platform_streaming(enabled: bool) -> tuple[bool, str]:
    """Set display.platforms.aji-chat.streaming via Hermes CLI.

    Returns (ok, detail). detail is stderr/exception text on failure.
    """
    value = "true" if enabled else "false"
    cmd = ["hermes", "config", "set", _STREAMING_CONFIG_KEY, value]
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except Exception as exc:
        return False, str(exc)

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "unknown error").strip()
        return False, detail
    return True, "ok"


async def _probe_duration_seconds(path: str) -> Optional[float]:
    """Best-effort media duration (seconds) via ffprobe. None if unavailable."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            ffprobe, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        if proc.returncode == 0:
            return round(float(out.decode().strip()), 2)
    except Exception:
        pass
    return None


async def _transcode_ogg_to_m4a(src_path: str) -> Optional[str]:
    """Transcode Ogg/Opus → AAC-in-m4a (iOS-playable). Returns the new temp
    path, or None when ffmpeg is unavailable or the transcode fails."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        flog_warn("transcode skipped: ffmpeg not on PATH")
        return None
    out_path = os.path.join(tempfile.gettempdir(), f"aji-audio-{uuid.uuid4().hex}.m4a")
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y", "-i", src_path, "-c:a", "aac", "-b:a", "96k", out_path,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode == 0 and os.path.exists(out_path):
            return out_path
        flog_warn("transcode failed rc=%s: %.200s", proc.returncode,
                  err.decode(errors="replace") if err else "")
    except Exception as exc:
        flog_warn("transcode error: %s", exc)
    return None


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
            "You are on aji-chat. Tool calls render as structured cards "
            "Aji-chat accepts plain text and Markdown."
        ),
    )

    # Per-tool and per-approval hooks — see hooks.py for filtering by platform.
    ctx.register_hook("pre_tool_call", hooks.on_pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.on_post_tool_call)
    ctx.register_hook("pre_approval_request", hooks.on_pre_approval)
    ctx.register_hook("post_approval_response", hooks.on_post_approval)
