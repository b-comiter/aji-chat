"""
Shared file-based logger for the aji-chat Hermes plugin.

All plugin modules import `flog` from here to write structured debug lines to
~/Desktop/hermes-aji.log. Using a completely separate named logger keeps our
output out of Hermes's log stream while ensuring every method call is captured.

Usage:
    from ._log import flog
    flog("send() chat_id=%s content=%.80r", chat_id, content)
"""
from __future__ import annotations

import logging
import os
import atexit

_LOG_PATH = os.path.expanduser("~/Desktop/hermes-aji.log")

_logger = logging.getLogger("aji_chat_plugin")
_handler: logging.FileHandler | None = None


def setup() -> None:
    """Configure the file handler once. Safe to call multiple times."""
    global _handler
    if _handler is not None:
        return  # already set up
    try:
        _handler = logging.FileHandler(_LOG_PATH, mode="a", encoding="utf-8")
        _handler.setLevel(logging.DEBUG)
        _handler.setFormatter(
            logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s",
                              datefmt="%H:%M:%S")
        )
        _logger.addHandler(_handler)
        _logger.setLevel(logging.DEBUG)
        _logger.propagate = False  # don't double-emit into Hermes's log stream
        atexit.register(_handler.close)
        _logger.info("=== aji-chat plugin logger started (pid %d) ===", os.getpid())
    except Exception as exc:  # noqa: BLE001
        # If we can't open the log file, fall back silently so the plugin
        # still functions — mirrors the fail-silent philosophy everywhere.
        import sys
        print(f"[aji-chat plugin] could not open log file {_LOG_PATH}: {exc}",
              file=sys.stderr)


def flog(msg: str, *args: object) -> None:
    """Write a DEBUG line to ~/Desktop/hermes-aji.log."""
    _logger.debug(msg, *args)


def flog_info(msg: str, *args: object) -> None:
    """Write an INFO line to ~/Desktop/hermes-aji.log."""
    _logger.info(msg, *args)


def flog_warn(msg: str, *args: object) -> None:
    """Write a WARNING line to ~/Desktop/hermes-aji.log."""
    _logger.warning(msg, *args)
