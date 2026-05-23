"""
HTTP client to the aji-chat server.

Thin wrapper over httpx.AsyncClient. Two public methods that matter:
    emit(event)            POST /event  — broadcast a ServerEvent to all clients
    register_webhook(url)  POST /webhook  — receive ClientEvents back
    deregister_webhook(url) DELETE /webhook

Notes:
- All methods fail silently (log + swallow). The aji-chat server being down
  must never break the Hermes agent — mirrors the Claude Code hook script's
  philosophy.
- `emit()` stamps `turn_id` automatically when the caller passes a chat_id and
  the SessionState has an active turn for it. Callers that already know the
  turn_id can also pass it explicitly.
- No `dismiss_prompt` / `/prompt/wait` — those don't fit the plugin model.
  See README for rationale.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from .state import SessionState

logger = logging.getLogger(__name__)


class AjiClient:
    def __init__(self, server_url: str, state: SessionState) -> None:
        # Strip trailing slash so we can naively concatenate paths.
        self.server_url = server_url.rstrip("/")
        self.state = state
        # 5s connect/read timeout — the server is local; if it's slow we
        # don't want to back up the agent.
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(5.0))

    async def close(self) -> None:
        await self._client.aclose()

    async def emit(
        self,
        event: dict[str, Any],
        *,
        chat_id: Optional[str] = None,
        turn_id: Optional[str] = None,
    ) -> None:
        """POST a single ServerEvent to /event. Stamps turn_id if available."""
        payload = dict(event)
        # Explicit turn_id wins; otherwise look up by chat_id.
        if turn_id is not None:
            payload.setdefault("turn_id", turn_id)
        elif chat_id is not None:
            current = self.state.current_turn(chat_id)
            if current is not None:
                payload.setdefault("turn_id", current)
        await self._post("/event", payload)

    async def register_webhook(self, url: str) -> None:
        await self._post("/webhook", {"url": url})

    async def deregister_webhook(self, url: str) -> None:
        try:
            response = await self._client.request(
                "DELETE", f"{self.server_url}/webhook", json={"url": url}
            )
            response.raise_for_status()
        except Exception as exc:
            logger.warning("aji-chat deregister_webhook failed: %s", exc)

    async def _post(self, path: str, body: dict[str, Any]) -> None:
        try:
            response = await self._client.post(f"{self.server_url}{path}", json=body)
            response.raise_for_status()
        except Exception as exc:
            logger.warning("aji-chat POST %s failed: %s", path, exc)
