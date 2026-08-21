import { describe, expect, it } from 'vitest'
import { ANCHOR_HOUR, pendingFireTime, shiftForRollover } from '../src/reminder'

describe('pendingFireTime', () => {
  it('pends at the reminder itself when it names a time', () => {
    expect(pendingFireTime('todo', '2026-06-14T18:00', undefined)).toBe('2026-06-14T18:00')
    expect(pendingFireTime('doing', '2026-06-14T18:00', undefined)).toBe('2026-06-14T18:00')
  })

  it('pends at the anchor hour when the reminder is only a day', () => {
    expect(pendingFireTime('todo', '2026-06-14', undefined)).toBe('2026-06-14T09:00')
    expect(ANCHOR_HOUR).toBe(9)
  })

  it('does not depend on the task at all beyond its status', () => {
    // The old signature took `due`, because a relative reminder resolved against
    // it. A reminder is a moment now (D79) — nothing about when it fires can
    // change when the due date does.
    expect(pendingFireTime.length).toBe(3)
  })

  it('done tasks never pend', () => {
    expect(pendingFireTime('done', '2026-06-14T18:00', undefined)).toBeNull()
    expect(pendingFireTime('done', '2026-06-14', undefined)).toBeNull()
  })

  it('does not re-fire once reminded at or after the fire time', () => {
    expect(pendingFireTime('todo', '2026-06-14T09:00', '2026-06-14T09:00')).toBeNull()
    expect(pendingFireTime('todo', '2026-06-14T09:00', '2026-06-14T09:00:30')).toBeNull()
    expect(pendingFireTime('todo', '2026-06-14T09:00', '2026-06-14T10:00')).toBeNull()
  })

  it('still pends when the last fire was before the fire time', () => {
    expect(pendingFireTime('todo', '2026-06-21T09:00', '2026-06-14T09:00')).toBe(
      '2026-06-21T09:00',
    )
  })

  // The rule that survives the grammar's deletion, and the reason `parseStamp`
  // returns null rather than throwing: a legacy `1d` in a hand-written file
  // shows as raw text and quietly never fires. It does not break the task.
  it('a legacy relative reminder is inert, never an error', () => {
    expect(pendingFireTime('todo', '1d', undefined)).toBeNull()
    expect(pendingFireTime('todo', '2w', undefined)).toBeNull()
    expect(pendingFireTime('todo', 'garbage', undefined)).toBeNull()
    expect(pendingFireTime('todo', undefined, undefined)).toBeNull()
  })
})

describe('shiftForRollover', () => {
  it('shifts a timed reminder by the due delta, keeping its clock time', () => {
    expect(shiftForRollover('2026-06-14T18:30', '2026-06-15', '2026-06-22')).toBe(
      '2026-06-21T18:30',
    )
    expect(shiftForRollover('2026-06-14T18:30', '2026-06-22', '2026-06-15')).toBe(
      '2026-06-07T18:30',
    )
  })

  it('shifts a timeless reminder and leaves it timeless', () => {
    expect(shiftForRollover('2026-06-14', '2026-06-15', '2026-06-22')).toBe('2026-06-21')
  })

  it('does not drift by hours when the due dates carry times of their own', () => {
    // The delta between the dues is a whole number of days plus four hours; the
    // reminder must move by the days and keep 18:30.
    expect(shiftForRollover('2026-06-14T18:30', '2026-06-15T09:00', '2026-06-22T13:00')).toBe(
      '2026-06-21T18:30',
    )
  })

  it('leaves an unparseable reminder or due unchanged (null)', () => {
    expect(shiftForRollover('1d', '2026-06-15', '2026-06-22')).toBeNull()
    expect(shiftForRollover('garbage', '2026-06-15', '2026-06-22')).toBeNull()
    expect(shiftForRollover('2026-06-14T18:30', 'not-a-date', '2026-06-22')).toBeNull()
    expect(shiftForRollover('2026-06-14T18:30', '2026-06-15', 'not-a-date')).toBeNull()
  })
})
