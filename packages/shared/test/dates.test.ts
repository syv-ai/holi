import { describe, expect, it } from 'vitest'
import {
  formatStamp,
  parseStamp,
  stampDate,
  stampEpoch,
  stampTime,
  withTime,
} from '../src/dates'

const HOUR_MS = 3_600_000

describe('parseStamp', () => {
  it('reads a bare date as midnight, and says it carried no time', () => {
    expect(parseStamp('2026-08-25')).toEqual({ epoch: Date.UTC(2026, 7, 25), timed: false })
  })

  it('reads a datetime, and says it carried one', () => {
    expect(parseStamp('2026-08-25T14:30')).toEqual({
      epoch: Date.UTC(2026, 7, 25, 14, 30),
      timed: true,
    })
  })

  it('accepts seconds, because parseDateTime always has', () => {
    expect(parseStamp('2026-08-25T14:30:05')).toEqual({
      epoch: Date.UTC(2026, 7, 25, 14, 30, 5),
      timed: true,
    })
  })

  // The old reminder grammar's two forms are the ones most likely to turn up in
  // a file written before D79, so they are named here rather than left to
  // "rubbish" — and they must be null, never a throw: an unparseable reminder is
  // inert, and a thrown error would take the whole task file down with it.
  it('rejects everything that is not a stamp, without throwing', () => {
    for (const bad of ['1d', '2w', '2026-8-5', '2026-02-30', '2026-08-25T24:00', '', 'today']) {
      expect(parseStamp(bad), bad).toBeNull()
    }
  })
})

describe('stampEpoch', () => {
  it('substitutes the default hour for a timeless stamp', () => {
    const midnight = stampEpoch('2026-08-25', 0)!
    expect(stampEpoch('2026-08-25', 9)).toBe(midnight + 9 * HOUR_MS)
  })

  it('ignores the default hour when the stamp names its own time', () => {
    expect(stampEpoch('2026-08-25T14:00', 9)).toBe(Date.UTC(2026, 7, 25, 14, 0))
  })

  it('is null for an unparseable stamp', () => {
    expect(stampEpoch('1d', 9)).toBeNull()
  })
})

describe('formatStamp', () => {
  it('drops the time when asked for a day, keeps it to the minute otherwise', () => {
    const epoch = Date.UTC(2026, 7, 25, 14, 30, 5)
    expect(formatStamp(epoch, false)).toBe('2026-08-25')
    expect(formatStamp(epoch, true)).toBe('2026-08-25T14:30')
  })

  it('round-trips through parseStamp in both shapes', () => {
    for (const s of ['2026-08-25', '2026-08-25T14:30']) {
      const parsed = parseStamp(s)!
      expect(formatStamp(parsed.epoch, parsed.timed)).toBe(s)
    }
  })
})

describe('stampDate and stampTime', () => {
  it('split a timed stamp into its halves', () => {
    expect(stampDate('2026-08-25T14:30')).toBe('2026-08-25')
    expect(stampTime('2026-08-25T14:30')).toBe('14:30')
  })

  it('give a timeless stamp a date and no time', () => {
    expect(stampDate('2026-08-25')).toBe('2026-08-25')
    expect(stampTime('2026-08-25')).toBeNull()
  })

  it('truncate seconds out of the time half', () => {
    expect(stampTime('2026-08-25T14:30:05')).toBe('14:30')
  })

  it('are both null for rubbish', () => {
    expect(stampDate('1d')).toBeNull()
    expect(stampTime('1d')).toBeNull()
  })
})

describe('withTime', () => {
  it('adds a time to a timeless stamp', () => {
    expect(withTime('2026-08-25', '09:00')).toBe('2026-08-25T09:00')
  })

  it('replaces the time on a timed one, keeping the date', () => {
    expect(withTime('2026-08-25T14:30', '18:00')).toBe('2026-08-25T18:00')
  })

  it('removes the time, leaving the day', () => {
    expect(withTime('2026-08-25T14:30', null)).toBe('2026-08-25')
  })

  it('removing a time that is not there is a no-op, not an error', () => {
    expect(withTime('2026-08-25', null)).toBe('2026-08-25')
  })

  it('is null for an unparseable stamp or an unparseable time', () => {
    expect(withTime('1d', '09:00')).toBeNull()
    expect(withTime('2026-08-25', '25:00')).toBeNull()
    expect(withTime('2026-08-25', 'noon')).toBeNull()
  })
})
