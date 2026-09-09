/**
 * A turn is recorded as a commit range (D88).
 *
 * The bracket this rides on already exists and already does something the vault
 * depends on: `setTurnActive` suspends sync for the turn and resumes it at the
 * end. So the constraint on every case here is that the recording is a passenger
 * — it must never delay the resume, never reject into the hook handler, and
 * never record for a vault that is no longer the one the turn ran in.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentManager, type AgentManager } from '../src/main/agent/agent-manager'
import type { TurnRecord } from '../src/main/agent/turn-log'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const VAULT = 'owner/repo'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

interface Rig {
  manager: AgentManager
  appended: TurnRecord[]
  resumes: () => number
  setActive: (remote: string | null) => void
  setHead: (sha: string | null) => void
}

async function rig(
  opts: {
    /** What `commitNow` answers. `null` is a clean tree. */
    commitNow?: () => Promise<string | null>
    turnSafetyMs?: number
    withLog?: boolean
  } = {},
): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-turn-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const workRoot = join(dir, 'work')
  await mkdir(join(workRoot, '.holi'), { recursive: true })

  let activeRemote: string | null = VAULT
  let head: string | null = 'base-sha'
  let resumes = 0
  const appended: TurnRecord[] = []

  const host = {
    active: (): ActiveVault | null =>
      activeRemote === null
        ? null
        : ({
            remote: activeRemote,
            root: workRoot,
            repo: { head: () => Promise.resolve(head) },
            commitNow: opts.commitNow ?? (() => Promise.resolve('end-sha')),
            pause: () => {},
            resume: () => {
              resumes += 1
            },
          } as unknown as ActiveVault),
    open: async () => {
      throw new Error('not used')
    },
    close: async () => {},
  } as unknown as VaultHost

  const manager = createAgentManager({
    host,
    getWindow: () => ({ webContents: { send: () => {} } }) as never,
    spawnPty: () =>
      ({
        pid: 1,
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      }) as never,
    resolveBin: () => '/bin/fake-claude',
    killGraceMs: 20,
    turnSafetyMs: opts.turnSafetyMs,
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
  cleanups.push(() => manager.dispose())
  await manager.start({ vaultId: VAULT })

  return {
    manager,
    appended,
    resumes: () => resumes,
    setActive: (r) => (activeRemote = r),
    setHead: (s) => (head = s),
  }
}

/** The recording is fire-and-forget, so a test has to let the microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 10))

describe('recording a turn', () => {
  it('records the range from turn start to the settle commit', async () => {
    const r = await rig()
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(false)
    await settle()
    expect(r.appended).toHaveLength(1)
    expect(r.appended[0]).toMatchObject({ base: 'base-sha', end: 'end-sha' })
    expect(typeof r.appended[0]!.at).toBe('string')
  })

  it('falls back to head() when the turn committed nothing', async () => {
    // `commitNow` answers null on a clean tree, which is the ordinary outcome of
    // a turn that only read. The range is then empty and the log drops it, but
    // this asks the right question rather than recording `undefined`.
    const r = await rig({ commitNow: () => Promise.resolve(null) })
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(false)
    await settle()
    expect(r.appended[0]).toMatchObject({ base: 'base-sha', end: 'base-sha' })
  })

  it('records the same way when the safety cap ends the turn', async () => {
    // Stop is not guaranteed: an interrupt or a crash leaves the turn open, and
    // the cap is what resumes the vault. A turn that ended that way still
    // happened and still changed files.
    vi.useFakeTimers()
    try {
      const r = await rig({ turnSafetyMs: 50 })
      r.manager.setTurnActive(true)
      await vi.advanceTimersByTimeAsync(60)
      vi.useRealTimers()
      await settle()
      expect(r.appended[0]).toMatchObject({ base: 'base-sha', end: 'end-sha' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes the vault even when the commit throws, and records nothing', async () => {
    // The resume is the part the vault depends on. A failed record must not
    // take it down with it.
    const r = await rig({ commitNow: () => Promise.reject(new Error('index.lock')) })
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(false)
    await settle()
    expect(r.resumes()).toBe(1)
    expect(r.appended).toEqual([])
  })

  it('records nothing for a vault that is no longer the one the turn ran in', async () => {
    // A vault switch mid-turn. Recording against whichever vault is open now
    // would attribute this turn's work to a different one, which is the mistake
    // D87 caught in D86's migration.
    const r = await rig()
    r.manager.setTurnActive(true)
    r.setActive('someone/else')
    r.manager.setTurnActive(false)
    await settle()
    expect(r.appended).toEqual([])
  })

  it('records nothing when there is no log to record into', async () => {
    const r = await rig({ withLog: false })
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(false)
    await settle()
    expect(r.appended).toEqual([])
  })

  it('records nothing when the vault has no commits yet', async () => {
    const r = await rig()
    r.setHead(null)
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(false)
    await settle()
    expect(r.appended).toEqual([])
  })

  it('does not record a repeated start, only the bracket', async () => {
    const r = await rig()
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(false)
    await settle()
    expect(r.appended).toHaveLength(1)
  })
})
