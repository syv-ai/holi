import { describe, expect, it } from 'vitest'
import { parseReminder, pendingFireTime, resolveReminder, shiftForRollover } from '../src/reminder'

describe('parseReminder', () => {
  it('parses absolute local datetimes, minutes and seconds precision', () => {
    expect(parseReminder('2026-06-14T18:00')).toEqual({ kind: 'absolute', at: '2026-06-14T18:00' })
    expect(parseReminder('2026-06-14T18:00:30')).toEqual({
      kind: 'absolute',
      at: '2026-06-14T18:00:30',
    })
  })

  it('parses relative days and weeks (bare digits only)', () => {
    expect(parseReminder('0d')).toEqual({ kind: 'relative', days: 0 })
    expect(parseReminder('1d')).toEqual({ kind: 'relative', days: 1 })
    expect(parseReminder('2w')).toEqual({ kind: 'relative', days: 14 })
  })

  it('trims surrounding whitespace', () => {
    expect(parseReminder(' 1d ')).toEqual({ kind: 'relative', days: 1 })
  })

  it('throws on every invalid form, with an error documenting the accepted ones', () => {
    for (const bad of ['', '  ', 'nope', '+1d', '-1d', '1h', '18:00', '2026-06-14', 'd', '1']) {
      expect(() => parseReminder(bad), `expected throw for ${JSON.stringify(bad)}`).toThrow()
    }
    expect(() => parseReminder('nope')).toThrow(/1d/)
    expect(() => parseReminder('nope')).toThrow(/YYYY-MM-DDTHH:MM/)
  })

  it('rejects impossible calendar datetimes', () => {
    expect(() => parseReminder('2026-02-30T09:00')).toThrow()
    expect(() => parseReminder('2026-06-14T24:00')).toThrow()
  })
})

describe('resolveReminder', () => {
  it('absolute resolves to itself, ignoring due', () => {
    const spec = parseReminder('2026-06-14T18:00')
    expect(resolveReminder(spec, undefined)).toBe('2026-06-14T18:00')
    expect(resolveReminder(spec, '2026-07-01')).toBe('2026-06-14T18:00')
  })

  it('relative resolves against due at the 09:00 anchor', () => {
    expect(resolveReminder(parseReminder('1d'), '2026-06-15')).toBe('2026-06-14T09:00')
    expect(resolveReminder(parseReminder('0d'), '2026-06-15')).toBe('2026-06-15T09:00')
    expect(resolveReminder(parseReminder('1w'), '2026-06-15')).toBe('2026-06-08T09:00')
  })

  it('relative without a (parseable) due is inert', () => {
    expect(resolveReminder(parseReminder('1d'), undefined)).toBeNull()
    expect(resolveReminder(parseReminder('1d'), 'not-a-date')).toBeNull()
  })
})

describe('pendingFireTime', () => {
  it('pends when the task is open and never fired', () => {
    expect(pendingFireTime('todo', '1d', '2026-06-15', undefined)).toBe('2026-06-14T09:00')
    expect(pendingFireTime('doing', '1d', '2026-06-15', undefined)).toBe('2026-06-14T09:00')
  })

  it('done tasks never pend', () => {
    expect(pendingFireTime('done', '1d', '2026-06-15', undefined)).toBeNull()
  })

  it('does not re-fire once reminded at or after the fire time', () => {
    expect(pendingFireTime('todo', '1d', '2026-06-15', '2026-06-14T09:00')).toBeNull()
    expect(pendingFireTime('todo', '1d', '2026-06-15', '2026-06-14T09:00:30')).toBeNull()
  })

  it('re-arms when the fire time moves past the last fire (due rolled forward)', () => {
    expect(pendingFireTime('todo', '1d', '2026-06-22', '2026-06-14T09:00')).toBe(
      '2026-06-21T09:00',
    )
  })

  it('invalid or missing reminders are inert, never errors', () => {
    expect(pendingFireTime('todo', 'garbage', '2026-06-15', undefined)).toBeNull()
    expect(pendingFireTime('todo', undefined, '2026-06-15', undefined)).toBeNull()
  })
})

describe('shiftForRollover', () => {
  it('shifts an absolute reminder by the due-date delta, preserving time of day', () => {
    expect(shiftForRollover('2026-06-14T18:30', '2026-06-15', '2026-06-22')).toBe(
      '2026-06-21T18:30',
    )
    expect(shiftForRollover('2026-06-14T18:30', '2026-06-22', '2026-06-15')).toBe(
      '2026-06-07T18:30',
    )
  })

  it('leaves relative, invalid, or unparseable-due reminders unchanged (null)', () => {
    expect(shiftForRollover('1d', '2026-06-15', '2026-06-22')).toBeNull()
    expect(shiftForRollover('garbage', '2026-06-15', '2026-06-22')).toBeNull()
    expect(shiftForRollover('2026-06-14T18:30', 'not-a-date', '2026-06-22')).toBeNull()
  })
})
