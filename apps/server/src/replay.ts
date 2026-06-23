/**
 * Offline-reconnect replay selection — kept pure (no socket, no module state) so
 * the restart edge case is unit-testable without booting the WS server.
 *
 * The ring buffer is in-memory and its `seq` counter resets to 0 every time the
 * server process restarts. A client persists its `after_seq` cursor across app
 * launches, so after a server restart the client's cursor is *ahead* of the
 * fresh counter. Naively replaying `seq > after_seq` would then match nothing
 * and silently drop every event the new instance has emitted — the user taps a
 * push and finds no message. So when the cursor is at or beyond our next seq, we
 * treat it as a restart and replay the whole buffer instead.
 */
export interface BufferedEvent<T> {
  seq: number
  event: T
}

export function selectMissedEvents<T>(
  buffer: ReadonlyArray<BufferedEvent<T>>,
  afterSeq: number,
  nextSeq: number,
): BufferedEvent<T>[] {
  // Cursor ahead of (or equal to) the next seq we'd assign ⇒ it came from a
  // previous server instance; the seq space reset under it. Replay everything.
  if (afterSeq >= nextSeq) return buffer.slice()
  return buffer.filter((e) => e.seq > afterSeq)
}
