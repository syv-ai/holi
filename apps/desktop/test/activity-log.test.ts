/**
 * The activity log (docs/features/status-bar.md): a bounded ring of what Holi
 * did in the background, scrubbed of credentials as it is written.
 */
import { describe, expect, it } from 'vitest'
import { createActivityLog, errorText, scrubSecrets } from '../src/main/activity/log'
import { GitError } from '../src/main/git'

describe('activity log', () => {
  it('keeps lines oldest first, stamped and numbered', () => {
    const log = createActivityLog({ now: () => '2026-10-24T10:00:00.000Z' })
    log.write({ channel: 'git', message: 'Committed abc1234 Update a.md' })
    log.write({ channel: 'sync', level: 'warn', message: 'Sync: offline', remote: 'o/r' })
    expect(log.entries()).toEqual([
      {
        id: 1,
        at: '2026-10-24T10:00:00.000Z',
        channel: 'git',
        level: 'info',
        message: 'Committed abc1234 Update a.md',
      },
      {
        id: 2,
        at: '2026-10-24T10:00:00.000Z',
        channel: 'sync',
        level: 'warn',
        message: 'Sync: offline',
        remote: 'o/r',
      },
    ])
  })

  it('drops the oldest past its capacity, and ids keep counting', () => {
    const log = createActivityLog({ capacity: 3 })
    for (let i = 1; i <= 5; i++) log.write({ channel: 'app', message: `line ${i}` })
    expect(log.entries().map((e) => e.message)).toEqual(['line 3', 'line 4', 'line 5'])
    expect(log.entries().map((e) => e.id)).toEqual([3, 4, 5])
  })

  it('holds 2000 lines by default', () => {
    const log = createActivityLog()
    for (let i = 0; i < 2100; i++) log.write({ channel: 'app', message: String(i) })
    const all = log.entries()
    expect(all).toHaveLength(2000)
    expect(all[0]!.message).toBe('100')
    expect(all.at(-1)!.message).toBe('2099')
  })

  it('clears, and starts again after', () => {
    const log = createActivityLog({ capacity: 2 })
    log.write({ channel: 'app', message: 'a' })
    log.write({ channel: 'app', message: 'b' })
    log.write({ channel: 'app', message: 'c' })
    log.clear()
    expect(log.entries()).toEqual([])
    log.write({ channel: 'app', message: 'd' })
    expect(log.entries().map((e) => [e.id, e.message])).toEqual([[4, 'd']])
  })

  it('pushes each line as it is written, scrubbed', () => {
    const pushed: string[] = []
    const log = createActivityLog({ onEntry: (e) => pushed.push(`${e.message}|${e.detail}`) })
    log.write({
      channel: 'git',
      level: 'error',
      message: 'Push failed',
      detail:
        "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/o/r.git/'",
    })
    expect(pushed).toEqual([
      "Push failed|fatal: unable to access 'https://***@github.com/o/r.git/'",
    ])
  })

  it('a push that throws does not throw into the writer', () => {
    const log = createActivityLog({
      onEntry: () => {
        throw new Error('window gone')
      },
    })
    expect(() => log.write({ channel: 'app', message: 'x' })).not.toThrow()
    expect(log.entries()).toHaveLength(1)
  })

  it('drops an empty detail and caps a long one', () => {
    const log = createActivityLog()
    log.write({ channel: 'app', message: 'a', detail: '  \n' })
    log.write({ channel: 'app', message: 'b', detail: 'x'.repeat(10_000) })
    const [a, b] = log.entries()
    expect(a!.detail).toBeUndefined()
    expect(b!.detail!.length).toBe(4000)
  })
})

describe('scrubSecrets', () => {
  it.each([
    [
      'https://x-access-token:ghs_1234567890abcdefghij@github.com/o/r',
      'https://***@github.com/o/r',
    ],
    ['https://user:pass@example.com/x', 'https://***@example.com/x'],
    ['https://tok@github.com/o/r', 'https://***@github.com/o/r'],
    ['token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', 'token ***'],
    ['pat github_pat_11ABCDEFG0123456789_abcdefghijk', 'pat ***'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'Authorization: Bearer ***'],
    ['HOLI_GIT_TOKEN=secretvalue other', 'HOLI_GIT_TOKEN=*** other'],
    ['GITHUB_API_KEY=abc', 'GITHUB_API_KEY=***'],
  ])('%s', (input, out) => {
    expect(scrubSecrets(input)).toBe(out)
  })

  it('leaves ordinary text, a plain URL and an email alone', () => {
    const text = 'Pushed 2 commits to https://github.com/o/r; ask billy@example.com'
    expect(scrubSecrets(text)).toBe(text)
  })
})

describe('errorText', () => {
  it("prefers git's stderr, which says why", () => {
    expect(errorText(new GitError('git push failed (128)', 128, 'fatal: could not read\n'))).toBe(
      'fatal: could not read',
    )
  })
  it('falls back to the message', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
  })
})
