"""
AjiChatAdapter — Hermes platform adapter that mirrors agent activity into the
aji-chat mobile app.

Maps Hermes's call surface onto aji-chat's discriminated-union ServerEvent
protocol:

  Hermes call                      | aji-chat events
  --------------------------------- | --------------------------------------
  on_processing_start(event)        | status:thinking (mints turn_id)
  send(chat_id, content)            | message_start + text_delta (left open)
  edit_message(..., finalize=False) | text_delta (delta against last_sent)
  edit_message(..., finalize=True)  | text_delta (final delta) + message_end
  on_processing_complete(...)       | message_end for still-open msgs, status:idle
  send_typing(chat_id)              | status:working
  send_voice / send_video /         | file (base64 inline, mime by extension)
    send_document / send_image_file |
  pre_tool_call (hook)              | tool_start
  post_tool_call (hook)             | tool_end
  pre_approval_request (hook)       | permission_request (/approve · /deny buttons)

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

When streaming is ON, send() does NOT emit message_end — it leaves the message
open (tracked in last_sent + _open_message_scope) so the streaming cursor keeps
showing while edit_message() appends deltas; edit_message(..., finalize=True)
emits the final delta + message_end and forgets it.

When streaming is OFF (and for out-of-turn cron pushes), send() already carries
the COMPLETE text and nothing edits it, so send() emits message_end right away.
Leaving it open instead would strand the message on mobile — a perpetual
streaming cursor, and (since mobile only persists on message_end) it would
vanish when the user navigates away before the turn ends. The lone exception is
the in-place "⏳ Working…/Subagent" heartbeat (long_running_notifications),
which keeps getting edit_message'd, so it stays open until on_processing_complete
closes it along with any other still-open message for the turn (then status:idle).

Consequence worth knowing: a Hermes text approval is a one-shot send() that
then BLOCKS waiting for the user's /approve reply, so on_processing_complete()
hasn't run and no message_end arrives for it. The mobile reducer converts the
approval text into a prompt card on text_delta (not message_end) for exactly
this reason — see apps/mobile/hooks/useChatSessionReducer.ts.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import os
import re
import tempfile
import uuid
from typing import Any, Optional

# Local imports
from .client import AjiClient
from .state import SessionState
from .webhook_server import WebhookServer
from ._log import flog, flog_info, flog_warn
from .media import (
    IOS_INCOMPATIBLE_AUDIO_EXTS, guess_mime, set_platform_streaming,
    probe_duration_seconds, transcode_ogg_to_m4a,
)

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
from gateway.config import HomeChannel, Platform, PlatformConfig  # type: ignore[import-not-found]
from gateway.session import SessionSource  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)

# Cursor characters Hermes appends during streaming (default " ▉" per
# gateway/config.py). We strip these so they don't leak into the diff.
# Order matters: longer prefixes first.
_CURSOR_SUFFIXES = (" ▉", " ▍", "▉", "▍")

# aji-chat is Discord-style: a *server* (this platform, "hermes") holds many
# *channels*. Each channel maps to its own Hermes `chat_id` — i.e. its own
# session / history / context window — via the `room:` prefix. The mobile app
# sends a `channel` on every event; absent ⇒ the default channel below.
_DEFAULT_CHANNEL = "general"
_DEFAULT_USER_ID = "aji-mobile"


def _chat_id_for_channel(channel: Optional[str]) -> str:
    """Map a mobile channel id to a Hermes chat_id (one session per channel)."""
    return f"room:{channel or _DEFAULT_CHANNEL}"


def _resolve_home_chat_id(raw: Optional[str]) -> str:
    """Resolve AJI_HOME_CHANNEL into a routable home chat_id.

    Accepts a bare channel ("alerts"), a full chat_id ("room:alerts"), or the
    "default"/empty placeholder — all of which fall back to the default channel.
    aji-chat is a single-tenant personal app, so there's always a sensible home
    (the general channel) for gateway lifecycle notices to land in. `/sethome`
    writes a "room:<channel>" value here, which is passed through unchanged.
    """
    value = (raw or "").strip()
    if not value or value.lower() == "default":
        return _chat_id_for_channel(None)
    return value if value.startswith("room:") else _chat_id_for_channel(value)


# Bot-token analogue. Stored in ~/.hermes/.env exactly like DISCORD_BOT_TOKEN, so
# the same agent identity (and, later, its grants) persists across restarts.
_AGENT_TOKEN_ENV = "AJI_AGENT_TOKEN"


def _hermes_env_path() -> str:
    """Path to Hermes's env file (where bot tokens live). Honors HERMES_HOME."""
    base = os.getenv("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    return os.path.join(base, ".env")


def _persist_agent_token(token: str) -> None:
    """Write/update AJI_AGENT_TOKEN in ~/.hermes/.env and the live process env,
    mirroring how DISCORD_BOT_TOKEN is stored. Never raises."""
    try:
        path = _hermes_env_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        line = f"{_AGENT_TOKEN_ENV}={token}"
        existing: list[str] = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                existing = fh.read().splitlines()
        replaced = False
        for i, ln in enumerate(existing):
            if ln.strip().startswith(f"{_AGENT_TOKEN_ENV}="):
                existing[i] = line
                replaced = True
                break
        if not replaced:
            existing.append(line)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(existing) + "\n")
        os.environ[_AGENT_TOKEN_ENV] = token
        flog_info("_persist_agent_token() wrote %s to %s", _AGENT_TOKEN_ENV, path)
    except Exception as exc:
        flog_warn("_persist_agent_token() failed: %s", exc)

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

# Hermes also sends its native approval prompt as ordinary text via send(), e.g.:
#   ⚠️ **Dangerous command requires approval:** … Reply `/approve` to execute …
# The pre_approval_request hook already emits a structured permission_request for
# the same approval (full untruncated command + /approve · /deny buttons), so we
# suppress this redundant text — but only when the hook actually fired (see
# SessionState.consume_recent_approval_card), so configs without the hook still
# get the text-derived card on mobile. Anchor matches mobile/hooks/hermesApproval.ts.
_APPROVAL_PROMPT_RE = re.compile(r"Reply\s+`/approve`\s+to execute")


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


_RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30]
_POLL_INTERVAL = 300


class AjiChatAdapter(BasePlatformAdapter):
    """Bidirectional aji-chat ↔ Hermes adapter."""

    REQUIRES_EDIT_FINALIZE = True  # tell stream consumer to send finalize=True

    def __init__(self, config: PlatformConfig, **kwargs: Any) -> None:
        platform = Platform("aji-chat")
        super().__init__(config=config, platform=platform)
        global _current_adapter
        _current_adapter = self

        # The gateway rehydrates each platform's home_channel from
        # <PLATFORM>_HOME_CHANNEL at startup — but only for built-in platforms
        # (gateway/config.py). Plugin platforms are skipped, so aji-chat would
        # never have a home channel after a fresh start, which means gateway
        # lifecycle notices (shutdown/restart, "back online") are delivered to
        # Telegram et al. but silently dropped for aji-chat. Mirror the built-in
        # behavior here so those notices reach mobile too. `/sethome` overrides
        # this by writing AJI_HOME_CHANNEL; an explicit config.yaml home_channel
        # is left untouched.
        if config.home_channel is None:
            config.home_channel = HomeChannel(
                platform=platform,
                chat_id=_resolve_home_chat_id(os.getenv("AJI_HOME_CHANNEL")),
                name="aji-chat",
            )

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
        # Load our persisted agent token (Discord/Telegram bot-token analogue).
        # Absent on first ever connect — the server mints one we then persist.
        self._client = AjiClient(
            server_url=server_url, state=self._state, token=os.getenv(_AGENT_TOKEN_ENV),
        )
        self._webhook = WebhookServer(
            host=plugin_host,
            port=plugin_port,
            state=self._state,
            on_user_message=self._on_user_message,
            on_user_file=self._on_user_file,
            on_get_commands=self.push_commands,
            on_clear_channel=self._on_clear_channel,
            server_id=self._client.server_id,
        )
        self._running = False
        # Cached "is gateway token streaming on for aji-chat?" — resolved lazily
        # from config on first send and refreshed by the /stream command. Drives
        # whether send() finalizes a message immediately (see send()).
        self._streaming_cached: Optional[bool] = None
        # Per-channel last status (chat_id -> value) so a status change in one
        # channel isn't suppressed by an identical value in another.
        self._last_status: dict[str, str] = {}
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

    async def _on_server_connect(self, info: dict[str, Any]) -> None:
        """Tasks to run on first connect or reconnect after an outage.

        Extracted from _registration_monitor so the retry loop stays readable.
        """
        if info.get("token") and not self._client.token:
            self._client.set_token(str(info["token"]))
            _persist_agent_token(str(info["token"]))
        await self._client.register_webhook(self._webhook.url)
        logger.info("aji-chat webhook registered at %s", self._webhook.url)
        flog_info("_on_server_connect() agentId=%s", info.get("agentId"))
        # Advertise server metadata (Hermes is multi-channel).
        # serverId is stamped by emit() from the client's server_id.
        await self._client.emit({
            "type": "server_info",
            "monoChannel": False, "displayName": "Hermes",
        })
        await self.push_commands()

    async def _registration_monitor(self) -> None:
        """Register the webhook and keep it alive across aji-chat server restarts.

        Uses GET /status as the liveness probe (cheap, no server-log noise).
        POST /webhook is only sent when the connection is first established or
        restored after an outage — not on every poll. When the server comes
        back after a restart its webhook registry is cleared, so we re-register
        and re-push commands so mobile gets a fresh list.
        """
        registered = False
        attempt = 0

        while self._running:
            try:
                await self._client.probe()  # lightweight: GET /status
                if not registered:
                    # Identify this agent. On first ever connect (no token) the
                    # server mints one; persist it so the same agentId sticks
                    # across restarts (bot-token style).
                    info = await self._client.register_agent(name="Hermes") or {}
                    await self._on_server_connect(info)
                    registered = True
                    attempt = 0
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

    def _source_for_channel(self, channel: str) -> SessionSource:
        """Build the Hermes SessionSource for an aji-chat channel — one room (and
        thus one session / history / context window) per channel. Shared by every
        inbound handler so the chat_id / chat_name shape stays consistent."""
        return SessionSource(
            platform=self.platform,
            chat_id=_chat_id_for_channel(channel),
            chat_name=f"aji-chat #{channel}",
            chat_type="group",
            user_id=_DEFAULT_USER_ID,
            user_name="aji",
        )

    async def _on_user_message(self, payload: dict[str, Any]) -> None:
        text = str(payload.get("text", "")).strip()
        channel = payload.get("channel") or _DEFAULT_CHANNEL
        chat_id = _chat_id_for_channel(channel)
        flog("_on_user_message() channel=%s text=%.120r", channel, text)
        if not text:
            flog("_on_user_message() empty text, ignored")
            return

        # Adapter-owned command for toggling Hermes display streaming on this
        # platform. We handle it locally so mobile can flip the setting without
        # routing to the LLM. Match the command token exactly so "/streaming" or
        # a "/stream"-prefixed word isn't swallowed.
        if text.split()[0] == "/stream":
            await self._handle_stream_command(chat_id, text)
            return

        # Slash commands are routed as COMMAND type so gateway/run.py dispatches
        # them through the built-in command handlers (help, model, stop, etc.)
        # rather than forwarding them to the LLM.
        msg_type = MessageType.COMMAND if text.startswith("/") else MessageType.TEXT
        flog("_on_user_message() msg_type=%s", msg_type)

        # chat_id = "room:<channel>" gives each channel its own Hermes session
        # (separate history + context window). /new in one channel doesn't reset
        # another.
        source = self._source_for_channel(channel)
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

    async def _on_clear_channel(self, payload: dict[str, Any]) -> None:
        """Reset this channel's Hermes session when the user runs /clear on mobile.

        The mobile client has already wiped its own copy of the history; we mirror
        that on the agent side by dispatching the built-in `/new` command for this
        channel's room, which starts a fresh session (clears history + context
        window). Reusing the command path keeps this in lockstep with however
        `/new` is implemented rather than poking at session internals here.
        """
        channel = payload.get("channel") or _DEFAULT_CHANNEL
        flog_info("_on_clear_channel() channel=%s", channel)
        source = self._source_for_channel(channel)
        event = MessageEvent(
            text="/new",
            message_type=MessageType.COMMAND,
            source=source,
            message_id=uuid.uuid4().hex,
        )
        try:
            await self.handle_message(event)
        except Exception as exc:
            logger.exception("aji-chat: clear_channel /new dispatch raised: %s", exc)

    async def _on_user_file(self, payload: dict[str, Any]) -> None:
        """Materialize an inbound `user_file` event to disk and dispatch it as
        a MessageEvent with `media_urls` populated — the same shape the Discord
        adapter produces for audio attachments (gateway will route through
        whatever transcription / audio handling Hermes has configured).
        """
        mime = str(payload.get("mime", "")) or "application/octet-stream"
        b64 = str(payload.get("data", ""))
        channel = payload.get("channel") or _DEFAULT_CHANNEL
        if not b64:
            flog_warn("_on_user_file() empty data, ignored")
            return

        # Pick an extension. Audio recordings from the mobile composer arrive
        # as audio/mp4 (.m4a); fall back to a mimetypes guess for anything
        # else. Hermes's audio handlers key off file extension in places, so
        # this matters.
        ext = mimetypes.guess_extension(mime.split(";")[0].strip()) or ""
        if mime == "audio/mp4" and ext in ("", ".mp4"):
            ext = ".m4a"

        name = payload.get("name") or f"aji-upload-{uuid.uuid4().hex}{ext}"
        # Sanitize: only keep the basename, then ensure the extension matches
        # what we derived from the mime so downstream code doesn't get confused.
        name = os.path.basename(str(name))
        if ext and not name.lower().endswith(ext):
            name = name + ext

        tmp_dir = os.path.join(tempfile.gettempdir(), "aji-uploads")
        os.makedirs(tmp_dir, exist_ok=True)
        local_path = os.path.join(tmp_dir, f"{uuid.uuid4().hex}-{name}")
        try:
            with open(local_path, "wb") as fh:
                fh.write(base64.b64decode(b64))
        except Exception as exc:
            logger.warning("aji-chat: failed to write inbound file: %s", exc)
            flog_warn("_on_user_file() write failed: %s", exc)
            return

        flog_info("_on_user_file() wrote %s (%d bytes)", local_path, os.path.getsize(local_path))

        # Pick a MessageType so Hermes's downstream routing (e.g. transcription
        # for voice/audio) kicks in. Mobile voice mode records audio/mp4 — treat
        # it as VOICE (a recorded voice note), matching Discord's distinction
        # between a native voice message and a user-uploaded audio file.
        msg_type = MessageType.TEXT
        if mime.startswith("audio/"):
            msg_type = MessageType.VOICE
        elif mime.startswith("image/"):
            msg_type = MessageType.PHOTO
        elif mime.startswith("video/"):
            msg_type = MessageType.VIDEO

        caption = str(payload.get("text") or "").strip()

        source = self._source_for_channel(channel)
        event = MessageEvent(
            text=caption,
            message_type=msg_type,
            source=source,
            message_id=uuid.uuid4().hex,
            media_urls=[local_path],
            media_types=[mime],
        )
        try:
            await self.handle_message(event)
        except Exception as exc:
            logger.exception("aji-chat: handle_message raised for user_file: %s", exc)

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

        ok, detail = await set_platform_streaming(enabled)
        if not ok:
            await self._send_one_shot_message(chat_id, f"Failed to set streaming: {detail}")
            return

        # Keep the cached flag in sync so send()'s finalize-immediately decision
        # tracks the new setting even before the gateway restart fully applies it.
        self._streaming_cached = enabled
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
        except Exception as exc:
            logger.warning("aji-chat: could not build built-in command list: %s", exc)
            flog_warn("push_commands() COMMAND_REGISTRY failed: %s", exc)

        try:
            from hermes_cli.commands import _iter_plugin_command_entries  # type: ignore[import-not-found]
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
            logger.warning("aji-chat: could not build plugin command list: %s", exc)
            flog_warn("push_commands() plugin commands failed: %s", exc)

        # Adapter-owned command (processed in _on_user_message).
        if not any(c.get("name") == "stream" for c in commands):
            commands.append({
                "name": "stream",
                "description": "Toggle aji-chat streaming display mode",
                "category": "Plugin",
                "args_hint": "<on|off>",
            })

        flog_info("push_commands() sending %d commands", len(commands))
        await self._client.emit({"type": "commands", "commands": commands})

    # -------------------------------------------------------------------
    # Outbound: send / edit_message → aji-chat events
    # -------------------------------------------------------------------

    def _is_streaming(self) -> bool:
        """Whether gateway token-streaming is on for aji-chat (cached).

        Mirrors the gateway's own decision (gateway/run.py): a per-platform
        `display.platforms.aji-chat.streaming` override wins; otherwise follow
        the top-level streaming config. When streaming is OFF, send() carries a
        complete message and nothing edits it, so send() can close it right away
        (see send()). Resolved once and refreshed by the /stream command."""
        if self._streaming_cached is not None:
            return self._streaming_cached
        result = True
        try:
            from hermes_cli.config import read_raw_config  # type: ignore[import-not-found]
            from gateway.display_config import resolve_display_setting  # type: ignore[import-not-found]
            val = resolve_display_setting(read_raw_config(), "aji-chat", "streaming")
            if val is not None:
                result = bool(val)
            else:
                from gateway.config import load_gateway_config  # type: ignore[import-not-found]
                scfg = getattr(load_gateway_config(), "streaming", None)
                result = (
                    bool(getattr(scfg, "enabled", True))
                    and getattr(scfg, "transport", "auto") != "off"
                    if scfg is not None
                    else True
                )
        except Exception as exc:
            flog_warn("_is_streaming() resolve failed; assuming streaming on: %s", exc)
            result = True
        self._streaming_cached = result
        flog_info("_is_streaming() resolved=%s", result)
        return result

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

        # Drop Hermes's native approval text when the pre_approval hook already
        # emitted a structured permission_request for it — otherwise mobile shows
        # two identical cards. consume_recent_approval_card() only returns True if
        # the hook just fired, so hook-less configs still get the text-based card.
        if _APPROVAL_PROMPT_RE.search(cleaned) and self._state.consume_recent_approval_card():
            flog("send() suppressed Hermes text approval prompt (pre_approval hook emitted the card)")
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

        # Close the message now when nothing will follow up on it — otherwise it
        # stays "open" (unfinalized), which on mobile shows a perpetual streaming
        # cursor and (since mobile only persists on message_end) makes it vanish
        # when the user navigates away before the turn ends. Two such cases:
        #   - turn_id is None: out-of-turn push (cron delivery) — no
        #     on_processing_complete will ever run to close it.
        #   - streaming disabled: send() already carries the COMPLETE message text
        #     and nothing edits it afterwards. The lone exception is the in-place
        #     "⏳ Working…/Subagent" heartbeat, which keeps getting edit_message'd,
        #     so it must stay open until on_processing_complete closes it.
        is_heartbeat = cleaned.startswith("⏳")
        if turn_id is None or (not self._is_streaming() and not is_heartbeat):
            await self._client.emit(
                {"type": "message_end", "id": message_id},
                chat_id=chat_id, turn_id=turn_id,
            )
            return SendResult(success=True, message_id=message_id)

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
        await self._emit_status("working", chat_id)

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
        mime = guess_mime(path)
        display_name = name or os.path.basename(path)

        # Transcode iOS-incompatible audio (Ogg/Opus) to m4a so the clip plays
        # on both iOS and Android. Falls back to the original if ffmpeg is absent.
        if os.path.splitext(path)[1].lower() in IOS_INCOMPATIBLE_AUDIO_EXTS:
            transcoded = await transcode_ogg_to_m4a(path)
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
            is_av = mime.startswith(("audio/", "video/"))
            duration = await probe_duration_seconds(src_path) if is_av else None

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
        channel = chat_id[len("room:"):] if chat_id.startswith("room:") else chat_id
        return {"name": f"aji-chat #{channel}", "type": "group", "chat_id": chat_id}

    # -------------------------------------------------------------------
    # Turn lifecycle (status pill + turn_id minting)
    # -------------------------------------------------------------------

    async def _emit_status(self, value: str, chat_id: str) -> None:
        """Emit a status event for one channel, skipping the round-trip when that
        channel's value hasn't changed. The chat_id is threaded through so the
        client stamps the right `channel` — otherwise channel A's thinking/working
        pill would show up in channel B."""
        if self._last_status.get(chat_id) == value:
            flog("_emit_status() skipped duplicate chat_id=%s value=%s", chat_id, value)
            return
        self._last_status[chat_id] = value
        await self._client.emit({"type": "status", "value": value}, chat_id=chat_id)

    async def on_processing_start(self, event: MessageEvent) -> None:
        chat_id = event.source.chat_id if event.source else _chat_id_for_channel(None)
        turn_id = f"turn_{uuid.uuid4().hex}"
        flog_info("on_processing_start() chat_id=%s turn_id=%.12s", chat_id, turn_id)
        self._state.start_turn(chat_id, turn_id)
        await self._emit_status("thinking", chat_id)

    async def on_processing_complete(
        self, event: MessageEvent, outcome: ProcessingOutcome
    ) -> None:
        chat_id = event.source.chat_id if event.source else _chat_id_for_channel(None)
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
        await self._emit_status("idle", chat_id)

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
    runs in a separate process and there's no in-process adapter to call.

    `chat_id` comes from the cron destination (e.g. ``AJI_HOME_CHANNEL=room:daily-brief``).
    We strip the ``room:`` prefix to recover the channel and target it so the
    briefing lands in #daily-brief instead of broadcasting to every channel."""
    import httpx

    server_url = (
        os.getenv("AJI_SERVER_URL")
        or ((pconfig.extra or {}).get("server_url"))
        or "http://localhost:4000"
    ).rstrip("/")

    channel = chat_id[len("room:"):] if chat_id.startswith("room:") else (chat_id or _DEFAULT_CHANNEL)

    # Carry the agent token if we have one persisted, so the server can stamp the
    # agentId on the cron message (same identity as the live adapter).
    token = os.getenv(_AGENT_TOKEN_ENV)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            response = await client.post(
                f"{server_url}/send",
                json={"message": message, "serverId": "hermes", "channel": channel},
                headers=headers,
            )
            response.raise_for_status()
        return {"success": True, "message_id": None}
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
        # Cron destination, Discord-style. Set AJI_HOME_CHANNEL to a channel
        # target, e.g. "room:daily-brief" (the "room:" prefix is optional —
        # "daily-brief" works too). Cron output lands in that channel only.
        cron_deliver_env_var="AJI_HOME_CHANNEL",
        max_message_length=10_000,  # aji-chat has no platform-imposed limit
        emoji="📱",
        # aji-chat is a personal app — network access (same LAN) is the
        # auth boundary.  Set AJI_ALLOW_ALL_USERS=true to open the gateway.
        allow_all_env="AJI_ALLOW_ALL_USERS",
        platform_hint=(
            "You are on aji-chat, which has multiple channels (each a separate "
            "conversation). Markdown renders inline.\n"
            "Reach aji-chat with the aji-chat tools ONLY:\n"
            "- Send a FILE (image, screenshot, PDF, HTML, markdown, audio, any "
            "document): aji_file(path, channel?, caption?) with the file's "
            "absolute path. Writing a file to disk does NOT send it.\n"
            "- Post or read TEXT in another channel: "
            "aji_channel(action='list'|'send', channel, message).\n"
            "- Channel names must be exact — call aji_channel(action='list') "
            "first to get them (e.g. 'general', 'daily-brief').\n"
            "Do NOT use `hermes send`, send_message, or the terminal to reach "
            "aji-chat: native send cannot resolve aji-chat channels and will fail."
        ),
    )

    # Per-tool and per-approval hooks — see hooks.py for filtering by platform.
    ctx.register_hook("pre_tool_call", hooks.on_pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.on_post_tool_call)
    ctx.register_hook("pre_approval_request", hooks.on_pre_approval)
    ctx.register_hook("post_approval_response", hooks.on_post_approval)

    # Agent-facing tool: discover + message channels from any session. Registered
    # into the shared "messaging" toolset so it rides alongside `send_message`.
    # Guarded — older Hermes builds without register_tool must not break loading.
    if hasattr(ctx, "register_tool"):
        from . import channel_tools
        try:
            ctx.register_tool(
                name="aji_channel",
                toolset="messaging",
                schema=channel_tools.AJI_CHANNEL_SCHEMA,
                handler=channel_tools.handle_aji_channel,
                emoji="📡",
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("aji-chat: failed to register aji_channel tool: %s", exc)
        try:
            ctx.register_tool(
                name="aji_file",
                toolset="messaging",
                schema=channel_tools.AJI_FILE_SCHEMA,
                handler=channel_tools.handle_aji_file,
                emoji="📎",
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("aji-chat: failed to register aji_file tool: %s", exc)
