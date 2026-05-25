"""
Per-session state for the aji-chat Hermes plugin.

Three tracking concerns live here so the adapter, hooks, and webhook listener
can share a single source of truth without circular imports:

1. `turns` — current `turn_id` keyed by chat_id. Minted in `on_processing_start`,
   cleared in `on_processing_complete`. Stamped onto every outbound event so
   the mobile UI can group them visually.

2. `last_sent` — last full text we emitted for a given streaming message_id.
   The Hermes stream consumer calls `edit_message()` with the full accumulated
   text each time; we diff against `last_sent[message_id]` to compute the
   incremental `text_delta` payload aji-chat expects.

3. `pending_prompts` — asyncio Futures keyed by prompt_id. Approval/clarify
   hooks await these; the webhook listener resolves them when the matching
   `prompt_response` arrives from the mobile client.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SessionState:
    # chat_id -> active turn_id (None when no turn is in flight)
    turns: dict[str, str] = field(default_factory=dict)

    # message_id -> last full text we sent (cursor-stripped) for diffing
    last_sent: dict[str, str] = field(default_factory=dict)

    # prompt_id -> Future awaiting the user's choice
    pending_prompts: dict[str, asyncio.Future[str]] = field(default_factory=dict)

    # task_id -> our generated tool_start id.
    # Hermes's pre_tool_call hook fires with tool_call_id="" (the real UUID
    # isn't assigned yet at that point), so we generate our own and stash it
    # here.  post_tool_call looks it up so tool_start and tool_end carry the
    # same id and mobile can pair them.
    pending_tool_ids: dict[str, str] = field(default_factory=dict)

    # --- turn tracking ---

    def start_turn(self, chat_id: str, turn_id: str) -> None:
        self.turns[chat_id] = turn_id

    def end_turn(self, chat_id: str) -> None:
        self.turns.pop(chat_id, None)

    def current_turn(self, chat_id: str) -> Optional[str]:
        return self.turns.get(chat_id)

    # --- streaming text bookkeeping ---

    def remember_sent(self, message_id: str, text: str) -> None:
        self.last_sent[message_id] = text

    def get_sent(self, message_id: str) -> str:
        return self.last_sent.get(message_id, "")

    def is_tracked(self, message_id: str) -> bool:
        return message_id in self.last_sent

    def forget_sent(self, message_id: str) -> None:
        self.last_sent.pop(message_id, None)

    # --- pending prompts ---

    def register_prompt(self, prompt_id: str) -> asyncio.Future[str]:
        fut: asyncio.Future[str] = asyncio.get_event_loop().create_future()
        self.pending_prompts[prompt_id] = fut
        return fut

    def resolve_prompt(self, prompt_id: str, choice: str) -> bool:
        """Resolve the future for prompt_id. Returns True if a future was
        resolved, False if the prompt is unknown / already resolved / cancelled
        (Hermes moved on, stale tap from mobile)."""
        fut = self.pending_prompts.get(prompt_id)
        if fut is None or fut.done():
            return False
        fut.set_result(choice)
        return True

    def drop_prompt(self, prompt_id: str) -> None:
        self.pending_prompts.pop(prompt_id, None)

    # --- tool call ID tracking ---

    def store_tool_id(self, task_id: str, tool_id: str) -> None:
        """Remember a generated tool_id for task_id so post_tool_call can pair it."""
        self.pending_tool_ids[task_id] = tool_id

    def pop_tool_id(self, task_id: str) -> Optional[str]:
        """Return and remove the stored tool_id for task_id, or None if absent."""
        return self.pending_tool_ids.pop(task_id, None)
