import { selectMissedEvents, type BufferedEvent } from './replay'

const buf = (seqs: number[]): BufferedEvent<string>[] =>
  seqs.map((seq) => ({ seq, event: `e${seq}` }))

describe('selectMissedEvents', () => {
  it('replays only events newer than the cursor in the normal case', () => {
    const buffer = buf([10, 11, 12, 13])
    const out = selectMissedEvents(buffer, 11, 14)
    expect(out.map((e) => e.seq)).toEqual([12, 13])
  })

  it('replays nothing when the client is caught up', () => {
    const buffer = buf([10, 11, 12])
    expect(selectMissedEvents(buffer, 12, 13)).toEqual([])
  })

  it('replays the whole buffer when the cursor is ahead of nextSeq (server restarted)', () => {
    // Client persisted after_seq=412 from a previous instance; the restarted
    // server's counter is back near 0. Naive filtering would drop everything.
    const buffer = buf([0, 1, 2, 3])
    const out = selectMissedEvents(buffer, 412, 4)
    expect(out.map((e) => e.seq)).toEqual([0, 1, 2, 3])
  })

  it('treats cursor == nextSeq as a restart (not "caught up")', () => {
    const buffer = buf([0, 1])
    expect(selectMissedEvents(buffer, 2, 2).map((e) => e.seq)).toEqual([0, 1])
  })

  it('returns a copy, not the live buffer', () => {
    const buffer = buf([0, 1])
    const out = selectMissedEvents(buffer, 412, 2)
    expect(out).not.toBe(buffer)
  })
})
