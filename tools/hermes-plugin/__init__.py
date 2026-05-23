"""aji-chat Hermes platform plugin.

The single public symbol Hermes looks for is `register`, which lives in
adapter.py. This module just re-exports it so the plugin loader finds it
at the top level.
"""
from . import _log as _log_module

# Set up ~/Desktop/hermes-aji.log as early as possible so every import
# that follows can already use flog().
_log_module.setup()

from .adapter import register  # noqa: E402

__all__ = ["register"]
