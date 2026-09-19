/**
 * The vault's working set (D100).
 *
 * Every case here is about the mismatch the coordinator exists for: the pause is
 * the VAULT's and the turn bracket is each SESSION's. So the questions are how
 * many times the vault is paused and resumed, which turns share a settle commit,
 * and which of them are told they overlapped another session.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTurnCoordinator } from '../src/main/agent/turn-coordinator'
import type { TurnRecord } from '../src/main/agent/turn-log'
import type { ActiveVault } from '../src/main/vault/active-vault'

const VAULT = 'owner/repo'

/** The recording is fire-and-forget, so a test has to let the microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 10))

function rig(
  opts: {
    commitNow?: () => Promise<string | null>
    turnSafetyMs?: number
    idleConfirmMs?: number
    withLog?: boolean
  } = {},
) {
  let activeRemote: string | null = VAULT
  let head: string | null = 'base-sha'
  let clock = 0
  const pauses: string[] = []
  let resumes = 0
  const appended: TurnRecord[] = []

  const activeVault = (): ActiveVault | null =>
    activeRemote === null
      ? null
      : ({
          remote: activeRemote,
          root: '/work',
          repo: { head: () => Promise.resolve(head) },
          commitNow: opts.commitNow ?? (() => Promise.resolve('end-sha')),
          pause: (reason: string) => pauses.push(reason),
          resume: () => {
            resumes += 1
          },
        } as unknown as ActiveVault)

  const coordinator = createTurnCoordinator({
    activeVault,
    log: () => {},
    now: () => clock,
    ...(opts.turnSafetyMs === undefined ? {} : { turnSafetyMs: opts.turnSafetyMs }),
    ...(opts.idleConfirmMs === undefined ? {} : { idleConfirmMs: opts.idleConfirmMs }),
    ...(opts.withLog === false
      ? {}
      : {
          turnLogFor: () => ({
            list: () => Promise.resolve(appended),
            append: async (r: TurnRecord) => {
              appended.unshift(r)
            },
          }),
        }),
  })

  return {
    coordinator,
    appended,
    pauses: () => pauses,
    resumes: () => resumes,
    tick: (ms: number) => (clock += ms),
    setActive: (r: string | null) => (activeRemote = r),
    setHead: (s: string | null) => (head = s),
  }
}

describe('the working set', () => {
  it('pauses on the first session in and resumes on the last one out', async () => {
    const r = rig()
    r.coordinator.begin('a')
    r.coordinator.begin('b')
    expect(r.pauses()).toEqual(['the assistant is working'])
    expect([...r.coordinator.working]).toEqual(['a', 'b'])

    r.coordinator.end('a')
    // The vault is still busy: `b` is mid-turn and holds the pause.
    expect(r.resumes()).toBe(0)
    expect([...r.coordinator.working]).toEqual(['b'])

    r.coordinator.end('b')
    expect(r.resumes()).toBe(1)
    expect(r.coordinator.working.size).toBe(0)
    await settle()
    // One pause, one resume, whatever happened in between.
    expect(r.pauses()).toHaveLength(1)
  })

  it('gives two overlapping turns one settle commit and tells them so', async () => {
    const r = rig()
    r.coordinator.begin('a')
    r.coordinator.begin('b')
    r.coordinator.end('a')
    r.coordinator.end('b')
    await settle()

    expect(r.appended).toHaveLength(2)
    const byId = Object.fromEntries(r.appended.map((rec) => [rec.sessionId, rec]))
    expect(byId['a']).toMatchObject({ base: 'base-sha', end: 'end-sha', overlapped: true })
    expect(byId['b']).toMatchObject({ base: 'base-sha', end: 'end-sha', overlapped: true })
  })

  it('does not mark two sequential turns as overlapping', async () => {
    const r = rig()
    r.coordinator.begin('a')
    r.coordinator.end('a')
    await settle()
    r.coordinator.begin('b')
    r.coordinator.end('b')
    await settle()

    expect(r.appended.map((rec) => rec.overlapped)).toEqual([false, false])
    expect(r.resumes()).toBe(2)
  })

  it('ignores a second begin for a session already mid-turn', () => {
    const r = rig()
    r.coordinator.begin('a')
    r.coordinator.begin('a')
    expect(r.pauses()).toHaveLength(1)
    // And it is not two members to leave: one `end` empties the set.
    r.coordinator.end('a')
    expect(r.resumes()).toBe(1)
  })

  it('ignores an end for a session that was not in the set', () => {
    const r = rig()
    r.coordinator.end('ghost')
    expect(r.resumes()).toBe(0)
    expect(r.pauses()).toEqual([])
  })
})

describe('the safety cap', () => {
  it('caps each session on its own clock and still resumes the vault once', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ turnSafetyMs: 50 })
      r.coordinator.begin('a')
      r.coordinator.begin('b')
      await vi.advanceTimersByTimeAsync(60)
      expect(r.coordinator.working.size).toBe(0)
      expect(r.resumes()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resume the vault under a session that is still working', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ turnSafetyMs: 50 })
      r.coordinator.begin('a')
      await vi.advanceTimersByTimeAsync(30)
      r.coordinator.begin('b') // its own cap starts now, 20ms behind a's
      await vi.advanceTimersByTimeAsync(25)
      // `a` is capped, `b` is not.
      expect([...r.coordinator.working]).toEqual(['b'])
      expect(r.resumes()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a capped turn the same way as one that stopped', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ turnSafetyMs: 50 })
      r.coordinator.begin('a')
      await vi.advanceTimersByTimeAsync(60)
      vi.useRealTimers()
      await settle()
      expect(r.appended[0]).toMatchObject({ base: 'base-sha', end: 'end-sha', sessionId: 'a' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a confirmed idle', () => {
  it('releases a session whose Stop never arrived', async () => {
    // Escaping a permission prompt fires no `Stop` hook at all, measured over
    // 166s. Before the listing existed, only the ten-minute cap ended that turn.
    const r = rig({ idleConfirmMs: 1000 })
    r.coordinator.begin('a')
    r.coordinator.noteIdle('a')
    expect([...r.coordinator.working]).toEqual(['a']) // one reading is not enough
    r.tick(1000)
    r.coordinator.noteIdle('a')
    expect(r.coordinator.working.size).toBe(0)
    expect(r.resumes()).toBe(1)
    await settle()
    expect(r.appended[0]).toMatchObject({ sessionId: 'a', end: 'end-sha' })
  })

  it('does not release on two readings taken too close together', () => {
    const r = rig({ idleConfirmMs: 1000 })
    r.coordinator.begin('a')
    r.coordinator.noteIdle('a')
    r.tick(50)
    r.coordinator.noteIdle('a')
    expect([...r.coordinator.working]).toEqual(['a'])
  })

  it('starts a new turn with no idle candidacy carried over', () => {
    const r = rig({ idleConfirmMs: 1000 })
    r.coordinator.begin('a')
    r.coordinator.noteIdle('a')
    r.tick(5000)
    r.coordinator.end('a')
    // A reading from the previous turn must not be half of the next turn's pair.
    r.coordinator.begin('a')
    r.coordinator.noteIdle('a')
    expect([...r.coordinator.working]).toEqual(['a'])
  })

  it('is a no-op for a session that is not mid-turn', () => {
    const r = rig()
    r.coordinator.noteIdle('a')
    r.tick(5000)
    r.coordinator.noteIdle('a')
    expect(r.resumes()).toBe(0)
  })
})

describe('a session that died', () => {
  it('leaves the set at once and records nothing', async () => {
    const r = rig()
    r.coordinator.begin('a')
    r.coordinator.forget('a')
    expect(r.coordinator.working.size).toBe(0)
    expect(r.resumes()).toBe(1) // the vault is never left paused behind a dead session
    await settle()
    expect(r.appended).toEqual([])
  })

  it('still lets the surviving session settle its own turn', async () => {
    const r = rig()
    r.coordinator.begin('a')
    r.coordinator.begin('b')
    r.coordinator.forget('a')
    r.coordinator.end('b')
    await settle()
    expect(r.appended.map((rec) => rec.sessionId)).toEqual(['b'])
    expect(r.appended[0]).toMatchObject({ overlapped: true })
  })
})

describe('what is not recorded', () => {
  it('resumes the vault even when the commit throws', async () => {
    const r = rig({ commitNow: () => Promise.reject(new Error('index.lock')) })
    r.coordinator.begin('a')
    r.coordinator.end('a')
    await settle()
    expect(r.resumes()).toBe(1)
    expect(r.appended).toEqual([])
  })

  it('records nothing for a vault that is no longer the one the turn ran in', async () => {
    const r = rig()
    r.coordinator.begin('a')
    r.setActive('someone/else')
    r.coordinator.end('a')
    await settle()
    expect(r.appended).toEqual([])
  })

  it('records nothing when there is no log to record into', async () => {
    const r = rig({ withLog: false })
    r.coordinator.begin('a')
    r.coordinator.end('a')
    await settle()
    expect(r.appended).toEqual([])
  })

  it('records nothing when the vault has no commits yet', async () => {
    const r = rig()
    r.setHead(null)
    r.coordinator.begin('a')
    r.coordinator.end('a')
    await settle()
    expect(r.appended).toEqual([])
  })

  it('falls back to head() when the turn committed nothing', async () => {
    const r = rig({ commitNow: () => Promise.resolve(null) })
    r.coordinator.begin('a')
    r.coordinator.end('a')
    await settle()
    expect(r.appended[0]).toMatchObject({ base: 'base-sha', end: 'base-sha' })
  })

  it('does nothing at all with no vault open', async () => {
    const r = rig()
    r.setActive(null)
    r.coordinator.begin('a')
    expect([...r.coordinator.working]).toEqual(['a'])
    r.coordinator.end('a')
    await settle()
    expect(r.appended).toEqual([])
  })
})
