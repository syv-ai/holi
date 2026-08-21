import { describe, expect, it } from 'vitest'
import {
  duePresets,
  reminderPresets,
  shortStamp,
} from '../src/renderer/src/lib/date-presets'

/** 2026-08-25 is a Tuesday. Mid-afternoon, so "this evening" is still ahead. */
const NOW = '2026-08-25T14:00'

const value = (presets: { label: string; value: string }[], label: string) =>
  presets.find((p) => p.label === label)?.value

describe('shortStamp', () => {
  it('shows a day, and a day with its time', () => {
    expect(shortStamp('2026-08-24')).toBe('24 Aug')
    expect(shortStamp('2026-08-24T09:00')).toBe('24 Aug, 09:00')
  })

  it('passes an unparseable stamp straight through', () => {
    expect(shortStamp('1d')).toBe('1d')
  })
})

describe('duePresets', () => {
  const presets = duePresets(NOW)

  it('writes days, never moments — a task is due on a day unless you say otherwise', () => {
    for (const p of presets) expect(p.value, p.label).not.toContain('T')
  })

  it('resolves the offsets from today', () => {
    expect(value(presets, 'today')).toBe('2026-08-25')
    expect(value(presets, 'tomorrow')).toBe('2026-08-26')
    expect(value(presets, 'in 3 days')).toBe('2026-08-28')
    expect(value(presets, 'in a week')).toBe('2026-09-01')
    expect(value(presets, 'in 2 weeks')).toBe('2026-09-08')
  })

  it('next Monday is the coming Monday', () => {
    // Tuesday 25 Aug → Monday 31 Aug.
    expect(value(presets, 'next Monday')).toBe('2026-08-31')
  })

  it('next Monday from a Monday is a week out, not today', () => {
    // 2026-08-31 is a Monday; "next Monday" must move, or the row does nothing.
    expect(value(duePresets('2026-08-31T14:00'), 'next Monday')).toBe('2026-09-07')
  })

  it('carries a hint showing where each one lands', () => {
    expect(presets.find((p) => p.label === 'tomorrow')?.hint).toBe('26 Aug')
  })

  it('is empty rather than throwing on an unparseable now', () => {
    expect(duePresets('not-a-date')).toEqual([])
  })
})

describe('reminderPresets — with a due date', () => {
  const presets = reminderPresets('2026-08-25', NOW)

  it('counts back from the due date, at the morning hour', () => {
    expect(value(presets, 'on the day')).toBe('2026-08-25T09:00')
    expect(value(presets, '1 day before')).toBe('2026-08-24T09:00')
    expect(value(presets, '3 days before')).toBe('2026-08-22T09:00')
    expect(value(presets, 'a week before')).toBe('2026-08-18T09:00')
    expect(value(presets, '2 weeks before')).toBe('2026-08-11T09:00')
  })

  it('always writes a moment — a notification with no time is not a notification', () => {
    for (const p of presets) expect(p.value, p.label).toContain('T')
  })

  it('offers "1 hour before" only when the due date names an hour', () => {
    expect(value(presets, '1 hour before')).toBeUndefined()
    const timed = reminderPresets('2026-08-25T14:00', NOW)
    expect(value(timed, '1 hour before')).toBe('2026-08-25T13:00')
  })

  it('uses the before-vocabulary, not the forward one', () => {
    expect(presets.map((p) => p.label)).toContain('1 day before')
    expect(presets.map((p) => p.label)).not.toContain('tomorrow')
  })
})

describe('reminderPresets — with no due date', () => {
  const presets = reminderPresets(undefined, NOW)

  it('reads forward from now instead of back from a due date', () => {
    expect(presets.map((p) => p.label)).toContain('in a week')
    expect(presets.map((p) => p.label)).not.toContain('a week before')
  })

  it('resolves the offsets from now, mornings for the whole days', () => {
    expect(value(presets, 'in an hour')).toBe('2026-08-25T15:00')
    expect(value(presets, 'tomorrow')).toBe('2026-08-26T09:00')
    expect(value(presets, 'in a week')).toBe('2026-09-01T09:00')
  })

  it('offers this evening while it is still ahead', () => {
    expect(value(presets, 'this evening')).toBe('2026-08-25T18:00')
  })

  it('drops this evening once it has passed — a row that does nothing is worse than no row', () => {
    expect(value(reminderPresets(undefined, '2026-08-25T19:30'), 'this evening')).toBeUndefined()
  })

  it('falls back to the forward vocabulary when the due date is unparseable', () => {
    // A legacy `1d` in `due` is not a date; the reminder shortcuts still have to
    // offer something rather than an empty rail.
    expect(reminderPresets('1d', NOW).map((p) => p.label)).toContain('in a week')
  })
})
