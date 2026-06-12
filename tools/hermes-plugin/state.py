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
import time
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

    # task_id -> (our generated tool_start id, chat_id at time of call).
    # Hermes's pre_tool_call hook fires with tool_call_id="" (the real UUID
    # isn't assigned yet at that point), so we generate our own and stash it
    # here.  post_tool_call looks it up so tool_start and tool_end carry the
    # same id and mobile can pair them.
    # chat_id is stashed alongside so tool_end can emit to the right channel.
    pending_tool_ids: dict[str, tuple[str, Optional[str]]] = field(default_factory=dict)

    # correlation_key -> prompt_id for observer-only approval cards.
    # Keyed by "<session_key>:<pattern_key>" so on_post_approval can look
    # up the prompt_id it needs to emit a prompt_dismiss.
    pending_approval_ids: dict[str, str] = field(default_factory=dict)

    # monotonic timestamp of the last approval card the pre_approval hook emitted.
    # Hermes ALSO sends its native approval prompt as ordinary text via send();
    # the adapter checks this to suppress that redundant text (avoiding a second
    # card) only when the hook actually fired. Global rather than per-chat — the
    # plugin already assumes a single active session (see active_chat_id()).
    last_approval_card_at: float = 0.0

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

    def active_chat_id(self) -> Optional[str]:
        """Return the single active chat_id, or None if zero or multiple are active.

        Hook callbacks don't receive chat_id directly. In the normal single-user
        case exactly one session is processing at a time, so this gives hooks the
        chat_id they need to stamp the correct channel on tool events.
        """
        active = list(self.turns.keys())
        return active[0] if len(active) == 1 else None

    def register_prompt(self, prompt_id: str) -> asyncio.Future[str]:
        fut: asyncio.Future[str] = asyncio.get_running_loop().create_future()
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

    def store_tool_id(self, task_id: str, tool_id: str, chat_id: Optional[str] = None) -> None:
        """Remember a generated tool_id + chat_id for task_id so post_tool_call can pair it."""
        self.pending_tool_ids[task_id] = (tool_id, chat_id)

    def pop_tool_id(self, task_id: str) -> tuple[Optional[str], Optional[str]]:
        """Return and remove (tool_id, chat_id) for task_id, or (None, None) if absent."""
        result = self.pending_tool_ids.pop(task_id, None)
        return result if result is not None else (None, None)

    # --- approval card tracking ---

    def store_approval_id(self, correlation_key: str, prompt_id: str) -> None:
        """Remember the prompt_id for an observer-only approval card."""
        self.pending_approval_ids[correlation_key] = prompt_id

    def pop_approval_id(self, correlation_key: str) -> Optional[str]:
        """Return and remove the prompt_id for correlation_key, or None if absent."""
        return self.pending_approval_ids.pop(correlation_key, None)

    def note_approval_card(self) -> None:
        """Mark that the pre_approval hook just emitted a structured approval card."""
        self.last_approval_card_at = time.monotonic()

    def consume_recent_approval_card(self, window: float = 10.0) -> bool:
        """True if a card was emitted within `window` seconds — and clears the
        mark so each card suppresses at most one redundant text prompt. Lets
        send() drop Hermes's native approval text when the hook already covered it."""
        if time.monotonic() - self.last_approval_card_at <= window:
            self.last_approval_card_at = 0.0
            return True
        return False
