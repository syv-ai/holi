/**
 * A turn is recorded as a commit range (D88), through the manager.
 *
 * The semantics of the range — the shared settle commit, the overlap marking,
 * the confirmed-idle release, what is not recorded — belong to the coordinator
 * and are covered in `turn-coordinator.test.ts`. What is left here is the join:
 * that the manager's bracket reaches the coordinator at all, that it carries the
 * session id, and that a record lands with the vault the turn ran in.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentManager, type AgentManager } from '../src/main/agent/agent-manager'
import type { TurnRecord } from '../src/main/agent/turn-log'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const VAULT = 'owner/repo'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** The recording is fire-and-forget, so a test has to let the microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 10))

async function rig(opts: { withLog?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-turn-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const workRoot = join(dir, 'work')
  await mkdir(join(workRoot, '.holi'), { recursive: true })

  let resumes = 0
  const appended: TurnRecord[] = []
  const roots: string[] = []

  const host = {
    active: (): ActiveVault =>
      ({
        remote: VAULT,
        root: workRoot,
        repo: { head: () => Promise.resolve('base-sha') },
        commitNow: () => Promise.resolve('end-sha'),
        pause: () => {},
        resume: () => {
          resumes += 1
        },
      }) as unknown as ActiveVault,
    open: async () => {
      throw new Error('not used')
    },
    close: async () => {},
  } as unknown as VaultHost

  const manager: AgentManager = createAgentManager({
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
    killBackstopMs: 20,
    ...(opts.withLog === false
      ? {}
      : {
          turnLogFor: (root: string) => {
            roots.push(root)
            return {
              list: () => Promise.resolve(appended),
              append: async (r: TurnRecord) => {
                appended.unshift(r)
              },
            }
          },
        }),
  })
  cleanups.push(() => manager.dispose())
  const { id } = await manager.start({ vaultId: VAULT })

  return { manager, id, appended, roots, workRoot, resumes: () => resumes }
}

describe('recording a turn through the manager', () => {
  it('records the range, against the session that ran it', async () => {
    const r = await rig()
    r.manager.setTurnActive(r.id, true)
    r.manager.setTurnActive(r.id, false)
    await settle()

    expect(r.appended).toHaveLength(1)
    expect(r.appended[0]).toMatchObject({
      base: 'base-sha',
      end: 'end-sha',
      sessionId: r.id,
      overlapped: false,
    })
    expect(typeof r.appended[0]!.at).toBe('string')
    expect(r.roots).toEqual([r.workRoot]) // keyed by ROOT, never by remote
  })

  it('records one range per session when two turns overlap', async () => {
    const r = await rig()
    const second = (await r.manager.start({ vaultId: VAULT })).id
    r.manager.setTurnActive(r.id, true)
    r.manager.setTurnActive(second, true)
    r.manager.setTurnActive(r.id, false)
    r.manager.setTurnActive(second, false)
    await settle()

    expect(r.appended.map((rec) => rec.sessionId).sort()).toEqual([r.id, second].sort())
    expect(r.appended.every((rec) => rec.overlapped)).toBe(true)
    expect(r.resumes()).toBe(1) // one pause, one resume, two turns
  })

  it('does not record a repeated start, only the bracket', async () => {
    const r = await rig()
    r.manager.setTurnActive(r.id, true)
    r.manager.setTurnActive(r.id, true)
    r.manager.setTurnActive(r.id, false)
    await settle()
    expect(r.appended).toHaveLength(1)
  })

  it('resumes the vault with no log to record into', async () => {
    const r = await rig({ withLog: false })
    r.manager.setTurnActive(r.id, true)
    r.manager.setTurnActive(r.id, false)
    await settle()
    expect(r.resumes()).toBe(1)
    expect(r.appended).toEqual([])
  })
})
