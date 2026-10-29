/**
 * The sync engine's lines in the activity log (docs/features/vaults-sync.md,
 * Activity log): every commit, merge, push and conflict, and sync-state
 * changes, but not the quiet ticks.
 *
 * Real git, as `active-vault.test.ts`: a bare remote, our clone and a
 * teammate's.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { taskClaim } from '@holi/shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { openRepo, type GitRepo } from '../src/main/git'
import { createActivityLog, type ActivityLog } from '../src/main/activity/log'
import { openActiveVault, type ActiveVault } from '../src/main/vault/active-vault'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8_000
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}

const open: ActiveVault[] = []
afterEach(async () => {
  for (const v of open.splice(0)) await v.close().catch(() => {})
})
afterAll(cleanupFixtures)

const CLAIMS = async () => [{ ...taskClaim, plugin: 'tasks' }]

async function rig(opts: { pullIntervalMs?: number; repo?: (real: GitRepo) => GitRepo } = {}) {
  const origin = await makeRemote()
  const dir = await makeClone(origin)
  const teammate = await makeClone(origin, 'teammate')
  await sleep(150)
  const log: ActivityLog = createActivityLog()
  const real = openRepo(dir)
  const active = await openActiveVault({
    claims: CLAIMS,
    remote: 'syv-ai/notes',
    repo: opts.repo?.(real) ?? real,
    onSnapshot: () => {},
    onSyncState: () => {},
    activity: log.write,
    timings: {
      commitQuietMs: 50,
      pushQuietMs: 50,
      pullIntervalMs: opts.pullIntervalMs ?? 60_000,
      healIntervalMs: 60_000,
    },
  })
  open.push(active)
  const lines = () => log.entries().map((e) => `${e.channel}:${e.level}:${e.message}`)
  return { active, dir, teammate, log, lines }
}

async function theyPublish(teammate: string, rel: string, text: string) {
  await writeFile(join(teammate, rel), text, 'utf8')
  await plainGit(teammate, ['add', '-A'])
  await plainGit(teammate, ['commit', '-m', `write ${rel}`])
  await plainGit(teammate, ['push', 'origin', 'main'])
}

describe('activity log — sync engine', () => {
  it('logs an autosave commit with its sha, then the push', async () => {
    const { dir, log, lines } = await rig()
    await writeFile(join(dir, 'note.md'), 'hello\n', 'utf8')
    await waitFor('the push line', () => lines().some((l) => l.startsWith('git:info:Pushed')))
    const sha = (await plainGit(dir, ['rev-parse', '--short=7', 'HEAD'])).trim()
    const commit = log.entries().find((e) => e.message.startsWith('Committed'))!
    expect(commit).toMatchObject({
      channel: 'git',
      level: 'info',
      message: `Committed ${sha} Update note.md`,
      remote: 'syv-ai/notes',
    })
    expect(lines()).toContain('git:info:Pushed 1 commit to origin/main')
  })

  it('logs a merged pull, and a quiet pull not at all', async () => {
    const { active, teammate, lines } = await rig()
    await active.syncNow() // nothing to pull or push
    expect(lines().filter((l) => l.startsWith('git:'))).toEqual([])
    await theyPublish(teammate, 'theirs.md', 'theirs\n')
    await active.syncNow()
    expect(lines()).toContain('git:info:Pulled and merged 1 commit from origin')
    expect(active.syncInfo().lastSyncAt).not.toBeNull()
  })

  it('logs a conflict with its paths, as an error, once', async () => {
    const { active, dir, teammate, log } = await rig({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict', () => active.syncState().kind === 'conflict')
    await sleep(300)
    const conflicts = log.entries().filter((e) => e.message.startsWith('Merge conflict'))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ channel: 'git', level: 'error', detail: 'README.md' })
    const states = log
      .entries()
      .filter((e) => e.channel === 'sync' && e.message.includes('conflict'))
    expect(states.map((e) => [e.level, e.message])).toEqual([['error', 'Sync: 1 file conflict']])
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Ours\n')
  })

  it("logs a failed push once, with git's own words, until it changes", async () => {
    const { active, dir, log } = await rig({
      repo: (real) => ({
        ...real,
        push: async () => {
          throw Object.assign(new Error('git push failed (128)'), {
            stderr:
              "fatal: unable to access 'https://x-access-token:ghs_secretsecretsecret1@github.com/o/r/': Could not resolve host",
          })
        },
      }),
    })
    await writeFile(join(dir, 'a.md'), 'a\n', 'utf8')
    await active.commitNow()
    await active.pushNow()
    await active.pushNow()
    const failures = log.entries().filter((e) => e.message === 'Push failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toBe(
      "fatal: unable to access 'https://***@github.com/o/r/': Could not resolve host",
    )
    expect(failures[0]!.detail).not.toContain('ghs_')
    expect(
      log.entries().some((e) => e.channel === 'sync' && e.message.startsWith('Sync: offline')),
    ).toBe(true)
    expect(active.syncInfo().lastError).toMatch(/Could not resolve host/)
  })

  it('logs a manual pause and its lifting as state changes', async () => {
    const { active, lines } = await rig()
    active.pause('an agent turn is running')
    active.resume()
    await waitFor('up to date again', () => lines().includes('sync:info:Sync: up to date'))
    expect(lines()).toContain('sync:info:Sync paused: an agent turn is running')
  })
})
