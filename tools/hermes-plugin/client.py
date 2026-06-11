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
import os
from typing import Any, Optional

import httpx

from .state import SessionState
from ._log import flog, flog_warn

logger = logging.getLogger(__name__)


class AjiClient:
    def __init__(
        self,
        server_url: str,
        state: SessionState,
        token: Optional[str] = None,
        server_id: str = "hermes",
    ) -> None:
        # Strip trailing slash so we can naively concatenate paths.
        self.server_url = server_url.rstrip("/")
        self.state = state
        # The aji-chat server id this adapter represents (the conversation
        # container; "hermes"). Stamped on outbound events and used to scope our
        # webhook so we only receive ClientEvents targeting this server.
        self.server_id = server_id
        # The aji-chat agent token (Discord/Telegram bot-token analogue). Sent as
        # an Authorization: Bearer header on every agent→server POST; the server
        # validates it and stamps the public agentId on our events.
        self.token = token
        # 5s connect/read timeout — the server is local; if it's slow we
        # don't want to back up the agent.
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(5.0))

    def set_token(self, token: Optional[str]) -> None:
        self.token = token

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        access_token = os.getenv("AJI_ACCESS_TOKEN")
        if access_token:
            headers["X-Aji-Token"] = access_token
        return headers

    async def close(self) -> None:
        await self._client.aclose()

    async def register_agent(self, name: str = "Hermes") -> Optional[dict[str, Any]]:
        """Register this agent with the server. If we hold no token the server
        mints one; the returned {agentId, token} should be persisted by the
        caller. With a known token the server returns the existing agentId.
        Returns the parsed body, or None on failure (never raises)."""
        try:
            response = await self._client.post(
                f"{self.server_url}/agent/register",
                json={"name": name},
                headers=self._headers(),
            )
            response.raise_for_status()
            body = response.json()
            flog("register_agent() ok agentId=%s minted=%s",
                 body.get("agentId"), body.get("token") is not None and not self.token)
            return body
        except Exception as exc:
            logger.warning("aji-chat register_agent failed: %s", exc)
            flog_warn("register_agent() failed: %s", exc)
            return None

    async def emit(
        self,
        event: dict[str, Any],
        *,
        chat_id: Optional[str] = None,
        turn_id: Optional[str] = None,
    ) -> None:
        """POST a single ServerEvent to /event. Stamps serverId, channel, and turn_id if available.
        (agentId is stamped by the server from our bearer token, not here.)"""
        payload = dict(event)
        # Stamp the server id (the container — formerly the overloaded `agent`).
        payload.setdefault("serverId", self.server_id)
        # Derive the channel from the chat_id ("room:<channel>") so mobile routes
        # the event to the right channel within the server. Bare chat_ids (no
        # "room:" prefix) are passed through unchanged.
        if chat_id:
            channel = chat_id[len("room:"):] if chat_id.startswith("room:") else chat_id
            payload.setdefault("channel", channel)
        # Explicit turn_id wins; otherwise look up by chat_id.
        if turn_id is not None:
            payload.setdefault("turn_id", turn_id)
        elif chat_id is not None:
            current = self.state.current_turn(chat_id)
            if current is not None:
                payload.setdefault("turn_id", current)
        flog("emit() type=%s id=%s turn_id=%s serverId=%s channel=%s",
             payload.get("type"), payload.get("id"), payload.get("turn_id"),
             payload.get("serverId"), payload.get("channel"))
        await self._post("/event", payload)

    async def probe(self) -> None:
        """Lightweight server liveness check. Raises on any failure."""
        response = await self._client.get(f"{self.server_url}/status")
        response.raise_for_status()

    async def register_webhook(self, url: str) -> None:
        flog("register_webhook() url=%s serverId=%s", url, self.server_id)
        # Scope the webhook to our server so the aji-chat server only forwards
        # ClientEvents targeting us (not every other agent's messages).
        await self._post("/webhook", {"url": url, "serverId": self.server_id})
        flog("register_webhook() POST complete")

    async def deregister_webhook(self, url: str) -> None:
        flog("deregister_webhook() url=%s", url)
        try:
            response = await self._client.request(
                "DELETE", f"{self.server_url}/webhook", json={"url": url}, headers=self._headers(),
            )
            response.raise_for_status()
            flog("deregister_webhook() OK status=%d", response.status_code)
        except Exception as exc:
            logger.warning("aji-chat deregister_webhook failed: %s", exc)
            flog_warn("deregister_webhook() failed: %s", exc)

    async def _post(self, path: str, body: dict[str, Any]) -> None:
        try:
            response = await self._client.post(f"{self.server_url}{path}", json=body, headers=self._headers())
            response.raise_for_status()
        except Exception as exc:
            logger.warning("aji-chat POST %s failed: %s", path, exc)
            flog_warn("_post(%s) failed: %s", path, exc)
