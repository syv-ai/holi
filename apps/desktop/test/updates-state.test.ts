import { describe, expect, it } from 'vitest'
import {
  CHECK_COOLDOWN_MS,
  CHECK_STALE_MS,
  initialStatus,
  reduce,
  shouldCheck,
  type UpdateEvent,
  type UpdateStatus,
} from '../src/main/updates/state'

const fresh = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  ...initialStatus({ supported: true, enabled: true, version: '0.1.0' }),
  ...over,
})

const run = (status: UpdateStatus, ...events: UpdateEvent[]): UpdateStatus =>
  events.reduce((s, e) => reduce(s, e, 1_000), status)

describe('reduce', () => {
  it('walks a check through download to ready', () => {
    const s = run(
      fresh(),
      { type: 'check-started' },
      { type: 'available', version: '0.2.0' },
      { type: 'progress', percent: 41.6 },
      { type: 'downloaded' },
    )
    expect(s).toMatchObject({ state: 'ready', availableVersion: '0.2.0', percent: 100 })
  })

  it('goes back to idle when there is nothing new', () => {
    const s = run(fresh(), { type: 'check-started' }, { type: 'not-available' })
    expect(s).toMatchObject({ state: 'idle', availableVersion: null, lastCheckAt: 1_000 })
  })

  it('keeps a download in flight when a later check answers', () => {
    const downloading = run(
      fresh(),
      { type: 'available', version: '0.2.0' },
      { type: 'progress', percent: 10 },
    )
    expect(run(downloading, { type: 'not-available' }).state).toBe('downloading')
    expect(run(downloading, { type: 'available', version: '0.2.0' }).state).toBe('downloading')
    expect(run(downloading, { type: 'check-started' }).state).toBe('downloading')
  })

  it('keeps a ready update through a re-announcement', () => {
    const ready = run(fresh(), { type: 'available', version: '0.2.0' }, { type: 'downloaded' })
    expect(run(ready, { type: 'available', version: '0.2.0' }).state).toBe('ready')
  })

  it('leaves a failed download available to retry, and a failed check idle', () => {
    const failedDownload = run(
      fresh(),
      { type: 'available', version: '0.2.0' },
      { type: 'progress', percent: 50 },
      { type: 'error', message: 'net' },
    )
    expect(failedDownload).toMatchObject({ state: 'available', lastError: 'net', percent: null })
    const failedCheck = run(fresh(), { type: 'check-started' }, { type: 'error', message: '404' })
    expect(failedCheck).toMatchObject({ state: 'idle', lastError: '404' })
  })

  it('clamps progress to a whole percentage', () => {
    expect(run(fresh(), { type: 'progress', percent: 140 }).percent).toBe(100)
    expect(run(fresh(), { type: 'progress', percent: Number.NaN }).percent).toBe(0)
  })
})

describe('shouldCheck', () => {
  it('never checks a build that cannot update', () => {
    expect(shouldCheck(fresh({ supported: false }), 'user', 0)).toBe(false)
  })

  it('holds background checks to the cooldown and the preference', () => {
    const checked = fresh({ lastCheckAt: 0 })
    expect(shouldCheck(checked, 'background', CHECK_COOLDOWN_MS - 1)).toBe(false)
    expect(shouldCheck(checked, 'background', CHECK_COOLDOWN_MS)).toBe(true)
    expect(shouldCheck(fresh({ enabled: false }), 'background', 0)).toBe(false)
  })

  it('lets a person check at once, even with automatic updates off', () => {
    expect(shouldCheck(fresh({ lastCheckAt: 0, enabled: false }), 'user', 1)).toBe(true)
  })

  it('never checks over an update in hand', () => {
    for (const state of ['available', 'downloading', 'ready'] as const) {
      expect(shouldCheck(fresh({ state }), 'user', 0)).toBe(false)
    }
  })

  it('retries a check only once it has gone stale', () => {
    const checking = fresh({ state: 'checking', checkStartedAt: 0 })
    expect(shouldCheck(checking, 'user', CHECK_STALE_MS - 1)).toBe(false)
    expect(shouldCheck(checking, 'user', CHECK_STALE_MS)).toBe(true)
  })
})
