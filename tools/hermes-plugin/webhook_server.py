"""
Inbound webhook listener.

When the mobile client sends a ClientEvent (user_message / prompt_response)
over its WebSocket to the aji-chat server, the server forwards it to every
registered webhook URL via HTTP POST. This module is that webhook receiver
on the Hermes side.

A single route — POST /inbound — accepts a JSON ClientEvent. Dispatch by
`type`:
    user_message      → construct a MessageEvent, hand to adapter.handle_message()
    prompt_response   → resolve the SessionState's pending Future for that id

The server binds to AJI_PLUGIN_PORT (default 4001) and registers
    http://127.0.0.1:<port>/inbound
with the aji-chat server in `AjiChatAdapter.connect()`.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Coroutine

from aiohttp import web

from .state import SessionState

logger = logging.getLogger(__name__)

# Callback the adapter passes in: receives a fully-constructed event dict
# (we don't import MessageEvent here to keep this module focused on transport).
UserMessageHandler = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


class WebhookServer:
    def __init__(
        self,
        host: str,
        port: int,
        state: SessionState,
        on_user_message: UserMessageHandler,
    ) -> None:
        self.host = host
        self.port = port
        self.state = state
        self.on_user_message = on_user_message
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None

    @property
    def url(self) -> str:
        """URL to register with the aji-chat server's /webhook endpoint."""
        return f"http://{self.host}:{self.port}/inbound"

    async def start(self) -> None:
        app = web.Application()
        app.router.add_post("/inbound", self._handle_inbound)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()
        logger.info("aji-chat webhook listener on %s", self.url)

    async def stop(self) -> None:
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    async def _handle_inbound(self, request: web.Request) -> web.Response:
        try:
            payload: dict[str, Any] = await request.json()
        except Exception as exc:
            logger.warning("aji-chat webhook: bad JSON: %s", exc)
            return web.json_response({"ok": False, "error": "bad json"}, status=400)

        event_type = payload.get("type")
        if event_type == "user_message":
            text = str(payload.get("text", ""))
            await self.on_user_message({
                "text": text,
                "received_at": datetime.utcnow().isoformat(),
            })
            return web.json_response({"ok": True})

        if event_type == "prompt_response":
            prompt_id = str(payload.get("id", ""))
            choice = str(payload.get("choice", ""))
            resolved = self.state.resolve_prompt(prompt_id, choice)
            if not resolved:
                # Late tap / Hermes already moved on. Silent no-op per design.
                logger.debug(
                    "aji-chat webhook: prompt %s response arrived but no future is pending",
                    prompt_id,
                )
            return web.json_response({"ok": True, "resolved": resolved})

        logger.debug("aji-chat webhook: ignored event type %s", event_type)
        return web.json_response({"ok": True, "ignored": True})
