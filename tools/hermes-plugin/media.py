"""
Media helpers for the aji-chat Hermes adapter.

Mime guessing, duration probing (ffprobe), Ogg→m4a transcode (ffmpeg), and
streaming-config toggle. All functions here are stateless — no adapter
instance required — so they're testable in isolation.
"""
from __future__ import annotations

import asyncio
import mimetypes
import os
import shutil
import subprocess
import tempfile
import uuid
from typing import Optional

from ._log import flog_warn

# Audio extensions Hermes TTS may emit that iOS/AVFoundation cannot decode.
# _emit_file transcodes these to m4a/AAC before sending.
IOS_INCOMPATIBLE_AUDIO_EXTS = {".ogg", ".opus", ".oga"}

# Dotted config key written by set_platform_streaming and read by Hermes's
# resolve_display_setting (same path, different access pattern).
_STREAMING_CONFIG_KEY = "display.platforms.aji-chat.streaming"


def guess_mime(path: str, fallback: str = "application/octet-stream") -> str:
    """Guess MIME type by file extension; returns fallback if unknown."""
    mime, _ = mimetypes.guess_type(path)
    return mime or fallback


async def set_platform_streaming(enabled: bool) -> tuple[bool, str]:
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


async def probe_duration_seconds(path: str) -> Optional[float]:
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


async def transcode_ogg_to_m4a(src_path: str) -> Optional[str]:
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
