# File transport: from inline base64 to server-hosted URLs

> **Status:** design / not yet implemented. This is the architectural follow-up
> to the v1 inline-base64 `file` event. It is the path already flagged in
> `CLAUDE.md` ("a server-hosted-URL transport is the future path for large
> media").

## Problem

Today a file (image, audio, document) travels and lives as **base64 bytes inline**
in the `file` / `user_file` event:

- **Wire:** every byte crosses the WebSocket as base64 (~1.33× the raw size).
- **Server:** the event sits, in full, in the 500-entry broadcast ring buffer
  (`apps/server/src/index.ts`) — a handful of photos can dominate it and evict
  real conversation events from the missed-events replay.
- **SQLite:** `insertItem` stores the whole `Item` (base64 included) as a JSON
  blob in the `items.data` column (`apps/mobile/db/database.ts`).
- **RN state:** `useChatSession`'s in-memory window holds up to 200 `Item`s, each
  carrying its full base64 `data`. Image thumbnails decode the *full-resolution*
  payload to draw a 240px preview.

This is fine for the v1 target (short audio clips, the occasional screenshot) but
scales badly: memory pressure, a polluted replay buffer, and a DB that grows with
raw media instead of references.

## Goals

- Move large bytes **out of band**: upload once, reference by URL.
- Keep the **server a dumb router** for semantic events — the blob store is a
  separate, mechanical concern (store bytes, serve bytes), not event parsing.
- **Back-compatible**: inline base64 keeps working; clients prefer `url` when
  present. No flag day for agents or older app builds.
- **Lazy + cached** on mobile: fetch bytes only when a row renders or the viewer
  opens; reuse the existing cache-file materialization.

## Non-goals

- External object storage (S3/R2). v1 of this transport can host blobs on the
  aji-chat server's own disk; swapping in object storage later is an
  implementation detail behind the same endpoints.
- Encryption-at-rest / signed URLs. Note as a follow-up; the current server is
  already a trusted LAN component behind the access token.
- Resumable / chunked uploads. Single-shot `POST` is enough for the target media
  sizes; revisit if video lands.

## Protocol changes (`packages/protocol`)

Make the bytes optional and add a reference + metadata. `FileMessage` and
`UserFile` gain:

```ts
export interface FileMessage {
  type: 'file'
  id: string
  role: Role
  mime: string
  /** Inline bytes — now OPTIONAL. Present for small media / legacy senders. */
  data?: string
  /** Server-hosted location. When present, clients fetch from here. */
  url?: string
  /** Optional tiny inline preview (downscaled image / blurhash) for instant render. */
  thumbnail?: string
  /** Decoded byte size, so the UI can show size + decide whether to auto-fetch. */
  size?: number
  name?: string
  duration?: number
  text?: string
  turn_id?: TurnId
  serverId?: ServerId
  agentId?: AgentId
  channel?: ChannelId
}
```

`UserFile` gets the same `url?` / `size?` additions (no `thumbnail`/`role`).

**Invariant:** at least one of `data` or `url` is present. The `fileMessage` /
`userFileMessage` builders gain a `url`/`thumbnail`/`size` opt and keep emitting
`data` when given raw bytes.

## Server changes (`apps/server`)

Add a **blob store** alongside the existing HTTP surface — mechanical, no event
semantics:

- `POST /blob` — body is raw bytes (or multipart); returns `{ id, url, size }`.
  Stores under a content-addressed or random id. Enforces a max size (the limit
  that is *currently absent*).
- `GET /blob/:id` — streams bytes with the stored `Content-Type`. Supports
  `Range` so the audio player / PDF viewer can seek.
- `DELETE /blob/:id` (optional) — for retention/cleanup.

The router still does **not** parse `file` events. Blobs are an orthogonal
endpoint; the `file` event just happens to carry a `url` that points at it. The
broadcast ring buffer now holds tiny reference events instead of megabytes.

Retention: start with size-capped LRU on disk (or TTL). Document that blob loss
degrades gracefully — an old `file` event with a dead `url` falls back to its
`thumbnail`/"unavailable" state, exactly like a cleared OS cache today.

## Mobile send path (`hooks/useChatActions.ts`)

`sendAttachment` / `sendAudio` change from "read base64 → embed in event" to:

1. (images) downscale via `expo-image-manipulator` first.
2. `POST` the bytes to `/blob` → get `{ url, size }`.
3. Optionally compute a small `thumbnail` (downscaled base64 / blurhash) for
   instant peer render.
4. Emit `user_file` with `url` + `size` (+ `thumbnail`), **no `data`**.
5. Persist the local `Item` with the `url` (and the thumbnail), not the full
   bytes — the DB stops storing raw media.

Optimistic UX: show the local picked URI immediately; reconcile to the hosted
`url` after upload. Surface upload progress / failure + retry (a gap today).

## Mobile receive path

- **Reducer / `chatTypes`:** `Item` (kind `file`) gains `url?`, `thumbnail?`,
  `size?`; `data?` becomes optional.
- **Rendering:** `fileCache.ts` grows a `resolveFileUri(item)` that returns a
  local cache path by either (a) writing inline `data` (today's path) or
  (b) downloading `url` once via `FileSystem.downloadAsync` and caching by id.
  `AudioMessage`, `ImageMessage`, and `FileViewer` all consume that single
  resolver, so the url-vs-inline distinction stays in one place.
- **Thumbnails:** `ImageMessage` renders `thumbnail` (or a blurhash placeholder)
  immediately and swaps to the full image on demand — no full-res decode in the
  list.

## Back-compat & rollout

1. **Protocol first** — add the optional fields + builder opts; ship to all three
   packages. Old senders (inline `data`) and old clients (ignore `url`) keep
   working because `data` stays valid.
2. **Mobile reader** — teach `resolveFileUri` to prefer `url`, fall back to
   `data`. Safe to ship before any sender emits `url`.
3. **Server blob store** — add `/blob` endpoints + size cap.
4. **Mobile sender** — upload then emit `url`. Now the heavy path is gone.
5. **Agents** (Hermes adapter `_emit_file`, Claude hook) — opt into uploading
   instead of inlining, one adapter at a time. Each adapter change is isolated;
   the server never needs to know which transport an agent picked.

## Modularity check

- Protocol remains the single source of truth (fields added in one place).
- Server stays a dumb router for events; the blob store is a separate, swappable
  endpoint (disk now, object storage later, same contract).
- Each agent adapter migrates independently — connecting a new harness still
  means "translate events + POST", now with an optional "upload blob" step.

## Open questions

- **Thumbnail format:** downscaled base64 vs. blurhash vs. a second `/blob`
  thumbnail URL. Blurhash is tiny and instant but needs a decoder dep.
- **Auth on `/blob`:** reuse the existing access token header; signed URLs later.
- **Cleanup coupling:** should deleting a channel / clearing history also delete
  referenced blobs, or leave retention purely to the LRU/TTL policy?
