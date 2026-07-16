import { describe, expect, it } from 'vitest'
import { dailyCacheKey, localIsoDate } from '../src/renderer/src/state/daily'

describe('localIsoDate', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(localIsoDate(new Date(2026, 6, 15, 9, 30))).toBe('2026-07-15')
  })

  it('zero-pads months and days', () => {
    expect(localIsoDate(new Date(2026, 0, 2, 9, 30))).toBe('2026-01-02')
  })

  // The bug this function exists to avoid: toISOString() formats UTC, so late-evening
  // local time east of UTC reports *tomorrow* — and just after local midnight it reports
  // *yesterday*. Either way you land on, and mint, the wrong note.
  it('reports the local day, not the UTC one', () => {
    // 23:30 local on the 15th. In any timezone west of UTC this is already the 16th UTC.
    const lateEvening = new Date(2026, 6, 15, 23, 30)
    expect(localIsoDate(lateEvening)).toBe('2026-07-15')

    // 00:30 local on the 15th — east of UTC this is still the 14th UTC.
    const justAfterMidnight = new Date(2026, 6, 15, 0, 30)
    expect(localIsoDate(justAfterMidnight)).toBe('2026-07-15')
  })

  it('agrees with the date the local clock reports, whatever the runner’s zone', () => {
    const d = new Date(2026, 6, 15, 12, 0)
    expect(localIsoDate(d)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  })
})

describe('dailyCacheKey', () => {
  it('keys on vault and date together', () => {
    expect(dailyCacheKey('v1', '2026-07-15')).toBe('v1/2026-07-15')
  })

  // Why the date is in the key: a session left open across local midnight must ask for
  // tomorrow's note rather than being served yesterday's from cache.
  it('changes across midnight so a long session rolls over', () => {
    expect(dailyCacheKey('v1', '2026-07-15')).not.toBe(dailyCacheKey('v1', '2026-07-16'))
  })

  it('separates vaults on the same day', () => {
    expect(dailyCacheKey('v1', '2026-07-15')).not.toBe(dailyCacheKey('v2', '2026-07-15'))
  })
})
