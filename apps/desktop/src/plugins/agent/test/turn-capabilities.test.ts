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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { agentCapabilities } from '../main/host/capabilities'
import { openTurnLog } from '../main/host/turn-log'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { openRepo } from '../../../main/git'
import { commitFile, makeClone, makeRemote, plainGit } from '../../../../test/helpers/git-fixtures'

const REMOTE = 'syv-ai/turns'

/** A real clone, open as far as the entries can tell, whose commit is a plain
 *  `git commit`. */
async function rig() {
  const root = await makeClone(await makeRemote())
  const table = agentCapabilities({
    sessions: {} as never,
    own: {} as never,
    jobs: {} as never,
    fenced: {} as never,
    providers: () => [],
    terminals: {} as never,
    liveRemote: () => REMOTE,
    commitNow: () => plainGit(root, ['commit', '-am', 'revert']),
    defaultProvider: async () => 'claude' as const,
  })
  const ctx = {
    remote: REMOTE,
    root,
    bundle: null,
    core: { repo: () => openRepo(root), syncState: () => ({}) },
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

  it('uses the shared shown-path fence and keeps valid local/agent files visible', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    const base = (await repo.head())!
    for (const [path, value] of [
      ['USER.local.md', 'user-local'],
      ['.holi/memory/private.md', 'agent-memory'],
      ['.holi/State/token', 'machine-state'],
      ['.holi/STATE/token', 'mixed-case-state'],
    ] as const) {
      const abs = join(root, path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, value)
    }
    await plainGit(root, ['add', '-f', '-A'])
    await plainGit(root, ['commit', '-m', 'add private and visible paths'])
    const end = (await repo.head())!
    expect((await run('agent.turnFiles', { base, end })).map((file) => file.path)).toEqual([
      '.holi/memory/private.md',
      'USER.local.md',
    ])
    await expect(run('agent.turnDiff', { base, end, path: '.holi/STATE/token' })).rejects.toThrow()
  })

  it('does not cross-read a second vault with the same path', async () => {
    const first = await rig()
    const second = await rig()
    const firstRepo = openRepo(first.root)
    const secondRepo = openRepo(second.root)
    const firstBase = (await firstRepo.head())!
    const secondBase = (await secondRepo.head())!
    await commitFile(first.root, 'same.md', 'first vault secret\n')
    await commitFile(second.root, 'same.md', 'second vault secret\n')
    const firstEnd = (await firstRepo.head())!
    const secondEnd = (await secondRepo.head())!
    expect(
      await first.run('agent.turnDiff', { base: firstBase, end: firstEnd, path: 'same.md' }),
    ).toEqual({
      before: '',
      after: 'first vault secret\n',
    })
    expect(
      await second.run('agent.turnDiff', { base: secondBase, end: secondEnd, path: 'same.md' }),
    ).toEqual({
      before: '',
      after: 'second vault secret\n',
    })
  })

  it('refuses a rename whose old endpoint is a secret path', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    await writeFile(join(root, '.env'), 'secret contents')
    await plainGit(root, ['add', '-f', '.env'])
    await plainGit(root, ['commit', '-m', 'secret'])
    const base = (await repo.head())!
    await plainGit(root, ['mv', '.env', 'ordinary.md'])
    await plainGit(root, ['commit', '-m', 'rename'])
    const end = (await repo.head())!
    expect(await run('agent.turnFiles', { base, end })).toEqual([])
  })

  it('accepts full commit and tree ids but refuses blobs and revision expressions', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    const commit = (await repo.head())!
    const tree = (await plainGit(root, ['rev-parse', 'HEAD^{tree}'])).trim()
    expect(await run('agent.turnFiles', { base: commit, end: tree })).toEqual([])
    expect(await run('agent.turnDiff', { base: tree, end: tree, path: 'README.md' })).toEqual({
      before: '# Vault\n',
      after: '# Vault\n',
    })
    await writeFile(join(root, 'blob-source'), 'blob')
    const blob = (await plainGit(root, ['hash-object', '-w', 'blob-source'])).trim()
    await expect(run('agent.turnFiles', { base: blob, end: commit })).resolves.toEqual([])
    await expect(run('agent.turnFiles', { base: `${commit}^`, end: commit })).rejects.toThrow(
      /object id/,
    )
  })

  it('refuses non-object-id range arguments before invoking git', async () => {
    const { run, root } = await rig()
    const end = (await openRepo(root).head())!
    await expect(run('agent.turnFiles', { base: `${end}^`, end })).rejects.toThrow(/object id/)
    await expect(
      run('agent.turnDiff', { base: '--output=/tmp/out', end, path: 'note.md' }),
    ).rejects.toThrow(/object id/)
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

  it('keeps ordinary filenames resembling resource errors as normal adds', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    const base = (await repo.head())!
    await commitFile(root, 'time limit.md', 'time text\n')
    await commitFile(root, 'resource limit.md', 'resource text\n')
    const end = (await repo.head())!
    expect(await run('agent.turnDiff', { base, end, path: 'time limit.md' })).toEqual({
      before: '',
      after: 'time text\n',
    })
    expect(await run('agent.turnDiff', { base, end, path: 'resource limit.md' })).toEqual({
      before: '',
      after: 'resource text\n',
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
    await run('agent.revert', {
      path: 'note.md',
      text: 'I wrote this\n',
      base: 'agent wrote this\n',
    })
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('I wrote this\n')
    expect(await repo.head()).not.toBe(before)
  })

  it('deletes a file the turn created, so the vault is as it was before', async () => {
    const { run, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'new-note.md', 'the agent made this\n')
    const before = (await repo.head())!
    await run('agent.revert', { path: 'new-note.md', delete: true })
    await expect(readFile(join(root, 'new-note.md'), 'utf8')).rejects.toThrow()
    expect(await repo.head()).not.toBe(before)
    expect(await plainGit(root, ['ls-files', 'new-note.md'])).toBe('')
  })

  it('keeps what changed on disk since the turn, merged with what was kept', async () => {
    const { run, root } = await rig()
    const turnEnd = 'title\n\nagent line\n\nend\n'
    await commitFile(root, 'note.md', turnEnd)
    // The person typed at the top after the turn.
    await writeFile(join(root, 'note.md'), 'title, edited\n\nagent line\n\nend\n', 'utf8')
    await run('agent.revert', {
      path: 'note.md',
      text: 'title\n\nmy line\n\nend\n',
      base: turnEnd,
    })
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('title, edited\n\nmy line\n\nend\n')
  })

  it('writes nothing over a later change to the same lines', async () => {
    const { run, root } = await rig()
    await commitFile(root, 'note.md', 'agent line\n')
    await writeFile(join(root, 'note.md'), 'typed after the turn\n', 'utf8')
    const refused = await run('agent.revert', {
      path: 'note.md',
      text: 'my line\n',
      base: 'agent line\n',
    }).catch((err: { code?: string }) => err.code)
    expect(refused).toBe('CONFLICT')
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('typed after the turn\n')
  })

  it('refuses a path outside the vault', async () => {
    const { run } = await rig()
    await expect(run('agent.revert', { path: '../escape.md', delete: true })).rejects.toThrow()
    await expect(run('agent.revert', { path: '../escape.md', text: 'nope' })).rejects.toThrow()
    await expect(
      run('agent.revert', { path: '../escape.md', text: 'nope', base: '' }),
    ).rejects.toThrow()
  })

  it('does not write the file it refused', async () => {
    const { run, root } = await rig()
    await writeFile(join(root, 'keep.md'), 'original\n', 'utf8')
    await expect(
      run('agent.revert', { path: 'keep.md/../../outside.md', text: 'nope', base: '' }),
    ).rejects.toThrow()
    expect(await readFile(join(root, 'keep.md'), 'utf8')).toBe('original\n')
  })
})
