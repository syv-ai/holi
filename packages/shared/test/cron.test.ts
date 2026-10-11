import { describe, expect, it } from 'vitest'
import { CronError, describeCron, nextCronTime, parseCron, shortestGapMinutes } from '../src/cron'

/** A local wall-clock minute: the tests hold in any time zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

describe('parseCron', () => {
  it('reads steps, ranges, lists and names', () => {
    const c = parseCron('*/15 9-17 * jan,mar mon-fri')
    expect([...c.minutes]).toEqual([0, 15, 30, 45])
    expect([...c.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...c.months]).toEqual([1, 3])
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect(c.anyDay).toBe(true)
    expect(c.anyWeekday).toBe(false)
  })

  it('folds a 7 into Sunday, and expands the macros', () => {
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0])
    expect([...parseCron('@daily').hours]).toEqual([0])
  })

  it('says which field is wrong', () => {
    expect(() => parseCron('* * *')).toThrow(/five fields/)
    expect(() => parseCron('60 * * * *')).toThrow(CronError)
    expect(() => parseCron('0 25 * * *')).toThrow(/hour/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/)
    expect(() => parseCron('0 9-5 * * *')).toThrow(/backwards/)
  })
})

describe('nextCronTime', () => {
  it('finds the next half hour', () => {
    expect(nextCronTime(parseCron('*/30 * * * *'), at(2026, 10, 8, 10, 7))).toEqual(
      at(2026, 10, 8, 10, 30),
    )
  })

  it('is strictly after, so a run at the moment itself looks ahead', () => {
    expect(nextCronTime(parseCron('*/30 * * * *'), at(2026, 10, 8, 10, 30))).toEqual(
      at(2026, 10, 8, 11, 0),
    )
  })

  it('skips the weekend for a weekday schedule', () => {
    // 2026-10-09 is a Friday.
    expect(nextCronTime(parseCron('0 9 * * 1-5'), at(2026, 10, 9, 10))).toEqual(at(2026, 10, 12, 9))
  })

  it('matches either day field when both are restricted', () => {
    // The 15th, or any Monday: Monday 12 October comes first.
    expect(nextCronTime(parseCron('0 8 15 * 1'), at(2026, 10, 9))).toEqual(at(2026, 10, 12, 8))
  })

  it('crosses into the next year', () => {
    expect(nextCronTime(parseCron('0 0 1 1 *'), at(2026, 10, 8))).toEqual(at(2027, 1, 1))
  })

  it('answers null for a date that never comes', () => {
    expect(nextCronTime(parseCron('0 0 30 2 *'), at(2026, 1, 1))).toBeNull()
  })
})

describe('shortestGapMinutes', () => {
  it('reads the densest stretch of a day', () => {
    expect(shortestGapMinutes(parseCron('*/30 * * * *'))).toBe(30)
    expect(shortestGapMinutes(parseCron('* * * * *'))).toBe(1)
    expect(shortestGapMinutes(parseCron('0 9 * * *'))).toBe(24 * 60)
    // 23:58 to 00:01 across midnight.
    expect(shortestGapMinutes(parseCron('1,58 0,23 * * *'))).toBe(3)
  })
})

describe('describeCron', () => {
  it('says the common shapes in words', () => {
    expect(describeCron(parseCron('*/30 * * * *'))).toBe('Every 30 minutes')
    expect(describeCron(parseCron('5 * * * *'))).toBe('Hourly at :05')
    expect(describeCron(parseCron('0 9 * * *'))).toBe('Every day at 09:00')
    expect(describeCron(parseCron('30 8 * * 1-5'))).toBe('Weekdays at 08:30')
    expect(describeCron(parseCron('0 */2 * * *'))).toBe('Every 2 hours at :00')
    expect(describeCron(parseCron('*/30 7-18 * * 1-5'))).toBe(
      'Every 30 minutes, 07:00–18:59, weekdays',
    )
  })

  it('reads anything else as itself', () => {
    expect(describeCron(parseCron('0 8 1 * *'))).toBe('0 8 1 * *')
  })
})
