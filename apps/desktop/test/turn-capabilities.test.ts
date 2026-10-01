/**
 * The agent's turn capabilities.
 *
 * Reachability and the seams, not resolution: `rangeFiles` is tested on real
 * repositories in `git-range.test.ts` and the log on disk in `turn-log.test.ts`.
 * What only this rig can prove is that the entries answer over a real vault,
 * and that the two seams that touch the user's filesystem behave: a diff side
 * that does not exist answers `''` rather than throwing, and a path outside
 * the vault is refused.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { agentCapabilities } from '../src/main/agent/capabilities'
import { openTurnLog } from '../src/main/agent/turn-log'
import type { CapabilityContext } from '../src/main/capabilities/registry'
import { openRepo } from '../src/main/git'
import { commitFile, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const REMOTE = 'syv-ai/turns'

/** A real clone, open as far as the entries can tell, whose commit is a plain
 *  `git commit`. */
async function rig() {
  const root = await makeClone(await makeRemote())
  const table = agentCapabilities({
    sessions: {} as never,
    terminals: {} as never,
    liveRemote: () => REMOTE,
    commitNow: () => plainGit(root, ['commit', '-am', 'revert']),
  })
  const ctx = {
    remote: REMOTE,
    root,
    bundle: null,
    core: { repo: () => openRepo(root) },
  } as unknown as CapabilityContext
  /** Run an entry as dispatch does: params read first, then the entry. */
  const run = async <K extends keyof typeof table>(name: K, params: unknown = {}) => {
    const entry = table[name] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, p: unknown): Promise<unknown>
    }
    return entry.run(ctx, entry.params(params)) as Promise<
      Awaited<ReturnType<(typeof table)[K]['run']>>
    >
  }
  return { run, root }
}

describe('agent.turns', () => {
  it('is empty for a vault that has never run a turn', async () => {
    const { run } = await rig()
    expect(await run('agent.turns')).toEqual([])
  })

  it('answers with what the log holds, newest first', async () => {
    const { run, root } = await rig()
    const log = openTurnLog(root)
    await log.append({ base: 'a', end: 'b', at: '2026-09-09T10:00:00Z' })
    await log.append({ base: 'b', end: 'c', at: '2026-09-09T11:00:00Z' })
    const list = await run('agent.turns')
    expect(list.map((r) => r.end)).toEqual(['c', 'b'])
  })
})

describe('agent.turnFiles', () => {
  it('reports what the range changed', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    const base = (await repo.head())!
    await commitFile(root, 'note.md', 'one\ntwo\n')
    const end = (await repo.head())!
    expect(await run('agent.turnFiles', { base, end })).toEqual([
      { path: 'note.md', status: 'A', added: 2, removed: 0 },
    ])
  })

  it('is empty for a range whose shas are gone, rather than an error', async () => {
    // A turn record outlives the commits it names. The panel says "this turn's
    // history is gone"; it must not be handed a throw.
    const { run, root } = await rig()
    const end = (await openRepo(root).head())!
    expect(await run('agent.turnFiles', { base: '0'.repeat(40), end })).toEqual([])
  })
})

describe('agent.turnDiff', () => {
  it('gives both sides of a modified file', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'note.md', 'one\ntwo\n')
    const base = (await repo.head())!
    await commitFile(root, 'note.md', 'one\nCHANGED\n')
    const end = (await repo.head())!
    expect(await run('agent.turnDiff', { base, end, path: 'note.md' })).toEqual({
      before: 'one\ntwo\n',
      after: 'one\nCHANGED\n',
    })
  })

  it('gives an empty before for a file the turn added', async () => {
    // The side that does not exist is `''`, so the merge view reads it as a pure
    // add rather than failing. Same shape as `history.fileDiff`.
    const { run, root } = await rig()
    const repo = openRepo(root)
    const base = (await repo.head())!
    await commitFile(root, 'fresh.md', 'new\n')
    const end = (await repo.head())!
    expect(await run('agent.turnDiff', { base, end, path: 'fresh.md' })).toEqual({
      before: '',
      after: 'new\n',
    })
  })

  it('gives an empty after for a file the turn deleted', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'doomed.md', 'bye\n')
    const base = (await repo.head())!
    await rm(join(root, 'doomed.md'))
    await plainGit(root, ['add', '-A'])
    await plainGit(root, ['commit', '-m', 'delete'])
    const end = (await repo.head())!
    expect(await run('agent.turnDiff', { base, end, path: 'doomed.md' })).toEqual({
      before: 'bye\n',
      after: '',
    })
  })

  it('refuses a path outside the vault', async () => {
    const { run, root } = await rig()
    const sha = (await openRepo(root).head())!
    await expect(
      run('agent.turnDiff', { base: sha, end: sha, path: '../../etc/passwd' }),
    ).rejects.toThrow()
  })
})

describe('agent.revert', () => {
  it('writes the resolved text and commits it as a new commit', async () => {
    // Never a history rewrite, the same rule `history.restore` follows.
    const { run, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'note.md', 'agent wrote this\n')
    const before = (await repo.head())!
    await run('agent.revert', { path: 'note.md', text: 'I wrote this\n' })
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('I wrote this\n')
    expect(await repo.head()).not.toBe(before)
  })

  it('refuses a path outside the vault', async () => {
    const { run } = await rig()
    await expect(run('agent.revert', { path: '../escape.md', text: 'nope' })).rejects.toThrow()
  })

  it('does not write the file it refused', async () => {
    const { run, root } = await rig()
    await writeFile(join(root, 'keep.md'), 'original\n', 'utf8')
    await expect(
      run('agent.revert', { path: 'keep.md/../../outside.md', text: 'nope' }),
    ).rejects.toThrow()
    expect(await readFile(join(root, 'keep.md'), 'utf8')).toBe('original\n')
  })
})
