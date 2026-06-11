"""
Agent-facing tool: `aji_channel` — let the LLM discover and message aji-chat
channels from *any* session.

Why a custom tool instead of Hermes's built-in `send_message`? Each aji-chat
channel is its own session keyed by `chat_id = "room:<channel>"`. Hermes's
`send_message` target parser assumes *numeric* chat ids, so it can list our
channels but can't reliably send to a `room:<channel>` id. This tool sidesteps
that by posting straight to the aji-chat server's `/send` endpoint (the same
path `_standalone_send` uses for cron), carrying the agent's bearer token so the
server stamps the right `agentId`.

The handler is deliberately synchronous and self-contained (a blocking httpx
POST): tool handlers may run off the adapter's event loop, and going through
`/send` avoids any cross-thread use of the adapter's async client.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import uuid
from typing import Any

import httpx

from ._log import flog, flog_warn

_DEFAULT_CHANNEL = "general"
_AGENT_TOKEN_ENV = "AJI_AGENT_TOKEN"
_ACCESS_TOKEN_ENV = "AJI_ACCESS_TOKEN"

# Inline-base64 transport (the v1 file event) keeps the whole payload in the
# server ring buffer + SQLite + RN state, so cap it. Generous enough for
# screenshots, reports, and short clips; see docs/file-url-transport.md for the
# out-of-band follow-up that lifts this.
_MAX_FILE_BYTES = 25 * 1024 * 1024

# mimetypes doesn't know markdown; nudge the common doc types so the phone picks
# the right viewer (markdown renderer / WebView) instead of a generic chip.
_MIME_OVERRIDES = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
}


AJI_CHANNEL_SCHEMA: dict[str, Any] = {
    "name": "aji_channel",
    "description": (
        "Discover and message aji-chat channels (the Discord-style channels in the "
        "user's phone app). Each channel is a SEPARATE conversation with its own "
        "history — use this tool to reach a channel OTHER than the one you are "
        "currently replying in.\n"
        "- action='list': return the channels currently known to aji-chat. Call "
        "this FIRST to get exact channel names before sending.\n"
        "- action='send': post a message to a channel. Provide 'channel' (a short "
        "name like 'general' or 'daily-brief') and 'message'. If the channel does "
        "not exist yet it is created on the user's phone automatically.\n"
        "This is the ONLY way to post text to aji-chat — do NOT use `hermes send`, "
        "send_message, or the terminal; native send cannot resolve aji-chat channels."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "send"],
                "description": "'list' to see channels, 'send' to post a message.",
            },
            "channel": {
                "type": "string",
                "description": "Target channel name, e.g. 'general' or 'daily-brief'. Required for send; ignored for list.",
            },
            "message": {
                "type": "string",
                "description": "Message text to post. Required for send.",
            },
        },
        "required": ["action"],
    },
}


AJI_FILE_SCHEMA: dict[str, Any] = {
    "name": "aji_file",
    "description": (
        "Deliver a FILE to the user's aji-chat phone app — an image, screenshot, "
        "PDF, HTML page, markdown doc, audio clip, or any document. The phone shows "
        "images inline and opens documents in a full-screen viewer (markdown is "
        "rendered, HTML/PDF open in a viewer).\n"
        "IMPORTANT: writing a file to disk does NOT deliver it to the user — you "
        "must call this tool with the file's absolute path. The usual flow is: "
        "create the file (e.g. write it with the terminal), then call aji_file with "
        "that path. Use this whenever the user asks you to send, show, or share a "
        "file/image/screenshot/report/document.\n"
        "This is the ONLY way to deliver a file to aji-chat — do NOT use "
        "`hermes send --file` or the terminal; native send cannot resolve aji-chat "
        "channels. Call aji_channel(action='list') first if unsure of the channel name."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path to the file to send, e.g. '/tmp/report.html'.",
            },
            "channel": {
                "type": "string",
                "description": "Target channel name (e.g. 'general'). Defaults to 'general'. A new name is created on the phone automatically.",
            },
            "caption": {
                "type": "string",
                "description": "Optional caption/text shown alongside the file.",
            },
        },
        "required": ["path"],
    },
}


def _server_url() -> str:
    return (os.getenv("AJI_SERVER_URL") or "http://localhost:4000").rstrip("/")


def _auth_headers() -> dict[str, str]:
    """Bearer (agent identity) + optional access-token gate, matching the server."""
    headers: dict[str, str] = {}
    token = os.getenv(_AGENT_TOKEN_ENV)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    access = os.getenv(_ACCESS_TOKEN_ENV)
    if access:
        headers["X-Aji-Token"] = access
    return headers


def _guess_mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in _MIME_OVERRIDES:
        return _MIME_OVERRIDES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _list_channels() -> str:
    """Fetch the channel list from aji-chat. The server owns the channel registry
    (the source of truth, persisted server-side); Hermes reads it on demand via
    GET /channels rather than keeping its own directory copy."""
    try:
        response = httpx.get(
            f"{_server_url()}/channels",
            params={"serverId": "hermes"},
            headers=_auth_headers(),
            timeout=5.0,
        )
        response.raise_for_status()
        entries = response.json().get("channels", [])
    except Exception as exc:
        flog_warn("aji_channel list failed: %s", exc)
        return json.dumps({"error": f"Could not load channels: {exc}"})

    channels = [
        {"channel": entry["id"], "display": entry.get("displayName")}
        for entry in entries
        if entry.get("id")
    ]
    return json.dumps({"channels": channels})


def _send_to_channel(channel: str, message: str) -> str:
    try:
        response = httpx.post(
            f"{_server_url()}/send",
            json={"message": message, "serverId": "hermes", "channel": channel},
            headers=_auth_headers(),
            timeout=5.0,
        )
        response.raise_for_status()
        flog("aji_channel sent channel=%s", channel)
        return json.dumps({"ok": True, "channel": channel})
    except Exception as exc:
        flog_warn("aji_channel send failed channel=%s: %s", channel, exc)
        return json.dumps({"error": f"Send failed: {exc}"})


def _send_file(path: str, channel: str, caption: str | None) -> str:
    """Read a local file, base64-encode it, and POST a `file` event to aji-chat."""
    if not os.path.isfile(path):
        return json.dumps({"error": f"File not found: {path}"})
    try:
        size = os.path.getsize(path)
        if size > _MAX_FILE_BYTES:
            return json.dumps({
                "error": f"File is {size} bytes; the {_MAX_FILE_BYTES}-byte limit "
                         "for inline delivery was exceeded.",
            })
        with open(path, "rb") as fh:
            data_b64 = base64.b64encode(fh.read()).decode("ascii")
    except Exception as exc:
        flog_warn("aji_file read failed path=%s: %s", path, exc)
        return json.dumps({"error": f"Could not read file: {exc}"})

    mime = _guess_mime(path)
    name = os.path.basename(path)
    event: dict[str, Any] = {
        "type": "file",
        "id": f"file_{uuid.uuid4().hex}",
        "role": "assistant",
        "mime": mime,
        "data": data_b64,
        "name": name,
        "serverId": "hermes",
        "channel": channel,
    }
    if caption:
        event["text"] = caption

    try:
        response = httpx.post(
            f"{_server_url()}/event",
            json=event,
            headers=_auth_headers(),
            timeout=30.0,  # base64 payloads can be large
        )
        response.raise_for_status()
        flog("aji_file sent channel=%s name=%s mime=%s bytes=%d", channel, name, mime, size)
        return json.dumps({"ok": True, "channel": channel, "name": name, "mime": mime, "bytes": size})
    except Exception as exc:
        flog_warn("aji_file send failed name=%s: %s", name, exc)
        return json.dumps({"error": f"Send failed: {exc}"})


def handle_aji_channel(args: dict[str, Any], **_kw: Any) -> str:
    """Tool handler. Returns a JSON string (Hermes tool convention)."""
    action = str(args.get("action") or "send").lower()
    if action == "list":
        return _list_channels()

    channel = str(args.get("channel") or "").strip().lstrip("#")
    message = str(args.get("message") or "")
    if not channel:
        return json.dumps({"error": "A 'channel' is required for action='send'."})
    if not message:
        return json.dumps({"error": "A 'message' is required for action='send'."})
    return _send_to_channel(channel, message)


def handle_aji_file(args: dict[str, Any], **_kw: Any) -> str:
    """Tool handler for aji_file. Returns a JSON string (Hermes tool convention)."""
    path = str(args.get("path") or "").strip()
    if not path:
        return json.dumps({"error": "A 'path' (absolute file path) is required."})
    channel = str(args.get("channel") or _DEFAULT_CHANNEL).strip().lstrip("#") or _DEFAULT_CHANNEL
    caption = args.get("caption")
    caption = str(caption) if caption else None
    return _send_file(path, channel, caption)
