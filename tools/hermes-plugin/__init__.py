"""aji-chat Hermes platform plugin.

The single public symbol Hermes looks for is `register`, which lives in
adapter.py. This module just re-exports it so the plugin loader finds it
at the top level.
"""
from .adapter import register

__all__ = ["register"]
