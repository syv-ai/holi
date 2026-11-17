import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
  tmp,
} from './helpers/git-fixtures'

afterAll(cleanupFixtures)

describe('managed merge provenance', () => {
  it('records only a verified divergent merge commit', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    // Both clones start at the same remote commit; independent commits make
    // the histories divergent without mutating the remote from the local clone.
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])

    const records: Array<string | null> = []
    const repo = openRepo(local, {
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
    expect((await repo.pull()).kind).toBe('merged')
    expect(records).toHaveLength(1)
    const oid = records[0]
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    const parents = (await plainGit(local, ['--no-replace-objects', 'cat-file', '-p', oid!]))
      .split('\n\n')[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '))
    expect(parents).toHaveLength(2)
    expect(await plainGit(local, ['rev-parse', 'HEAD'])).toBe(oid)
  })

  it('declines attribution when a merge hook can rewrite HEAD and its reflog', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const hook = join(local, '.git', 'hooks', 'post-merge')
    await writeFile(
      hook,
      "#!/bin/sh\nset -eu\nmerge=$(git rev-parse HEAD)\ngit commit --allow-empty -m hook-created >/dev/null\ngit reflog delete 'HEAD@{1}'\n",
    )
    await chmod(hook, 0o755)
    const records: Array<string | null> = []
    const repo = openRepo(local, {
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
    expect((await repo.pull()).kind).toBe('merged')
    expect(await plainGit(local, ['log', '-1', '--format=%s'])).toBe('hook-created')
    expect(records).toEqual([null])
  })

  it('leaves a conflicting pull and remerge unowned until a plain Git commit', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'README.md', '# Local\n')
    await commitFile(teammate, 'README.md', '# Incoming\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const records: Array<string | null> = []
    const repo = openRepo(local, {
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
    expect((await repo.pull()).kind).toBe('conflict')
    expect(records).toEqual([null])
    await expect(plainGit(local, ['rev-parse', '--verify', 'MERGE_HEAD'])).rejects.toThrow()
    await expect(plainGit(local, ['merge', '--abort'])).rejects.toThrow()
    expect((await repo.remerge()).kind).toBe('conflict')
    await expect(plainGit(local, ['rev-parse', '--verify', 'MERGE_HEAD'])).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    )
    expect(records).toEqual([null, null])
    await writeFile(join(local, 'README.md'), '# Resolved\n')
    await plainGit(local, ['add', 'README.md'])
    await plainGit(local, ['commit', '-m', 'manual resolution'])
    expect(records).toEqual([null, null])
  })

  it('records auto-settled modify/delete merges using only the two merge parents', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'README.md', '# Local edit\n')
    await plainGit(teammate, ['rm', 'README.md'])
    await plainGit(teammate, ['commit', '-m', 'delete note'])
    const incoming = await plainGit(teammate, ['rev-parse', 'HEAD'])
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const records: Array<string | null> = []
    const repo = openRepo(local, {
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
    expect((await repo.pull()).kind).toBe('merged')
    const oid = records[0]
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    const commit = await plainGit(local, ['--no-replace-objects', 'cat-file', '-p', oid!])
    const parents = commit
      .split('\n\n')[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice('parent '.length))
    expect(parents).toHaveLength(2)
    expect(parents).toContain(incoming)
    expect(
      await plainGit(local, ['merge-base', '--is-ancestor', incoming, oid!]).catch(() => 'failed'),
    ).toBe('')
    expect(records).toEqual([oid])
  })

  it('reads raw parents despite an outside-trace replacement disguise', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    const ours = await plainGit(local, ['rev-parse', 'HEAD'])
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    const incoming = await plainGit(teammate, ['rev-parse', 'HEAD'])
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const wrapper = join(await tmp('holi-replace-object-'), 'git')
    const proof = join(await tmp('holi-replace-object-proof-'), 'raw-parent-read')
    await writeFile(
      wrapper,
      `#!/bin/sh
case " $* " in *" cat-file -p "*) printf 'read\\n' >> "$EVIDENCE_PROOF";; esac
git "$@"
status=$?
if [ "$1" = merge ] && [ $status -eq 0 ]; then
  merge=$(env -u GIT_TRACE2_EVENT git rev-parse HEAD)
  tree=$(env -u GIT_TRACE2_EVENT git rev-parse 'HEAD^{tree}')
  wrong=$(printf wrong | env -u GIT_TRACE2_EVENT git commit-tree "$tree" -p "$ours")
  env -u GIT_TRACE2_EVENT git replace "$wrong" "$merge"
  env -u GIT_TRACE2_EVENT git update-ref -m "$GIT_REFLOG_ACTION: disguised" HEAD "$wrong"
  env -u GIT_TRACE2_EVENT git reflog delete 'HEAD@{1}'
fi
exit $status
`,
    )
    await chmod(wrapper, 0o755)
    const records: Array<string | null> = []
    expect(
      (
        await openRepo(local, {
          gitPath: wrapper,
          env: { EVIDENCE_PROOF: proof, ours },
          commitProvenance: {
            begin: () => ({}),
            record: async (_ticket, _root, oid) => {
              records.push(oid)
            },
          },
        }).pull()
      ).kind,
    ).toBe('merged')
    expect(await readFile(proof, 'utf8')).toBe('read\n')
    const head = await plainGit(local, ['rev-parse', 'HEAD'])
    expect(head).not.toBe(incoming)
    const disguised = (await plainGit(local, ['cat-file', '-p', head]))
      .split('\n\n')[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '))
    expect(disguised).toHaveLength(2)
    const parents = (await plainGit(local, ['--no-replace-objects', 'cat-file', '-p', head]))
      .split('\n\n')[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice('parent '.length))
    expect(parents).toEqual([ours])
    expect(records).toEqual([null])
  })

  it('attributes only the final local merge, not fetched merge ancestry', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await plainGit(teammate, ['checkout', '-b', 'incoming-side'])
    await commitFile(teammate, 'side.md', 'side\n')
    await plainGit(teammate, ['checkout', 'main'])
    await commitFile(teammate, 'incoming.md', 'incoming\n')
    await plainGit(teammate, ['merge', '--no-edit', 'incoming-side'])
    const incomingMerge = await plainGit(teammate, ['rev-parse', 'HEAD'])
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const records: Array<string | null> = []
    expect(
      (
        await openRepo(local, {
          commitProvenance: {
            begin: () => ({}),
            record: async (_ticket, _root, oid) => {
              records.push(oid)
            },
          },
        }).pull()
      ).kind,
    ).toBe('merged')
    const own = records[0]
    expect(own).toMatch(/^[0-9a-f]{40}$/)
    expect(own).not.toBe(incomingMerge)
    const parents = (await plainGit(local, ['--no-replace-objects', 'cat-file', '-p', own!]))
      .split('\n\n')[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '))
    expect(parents).toHaveLength(2)
    expect(parents).toContain(`parent ${incomingMerge}`)
    expect(records).toEqual([own])
  })

  it('rejects unsolicited native amend sessions after the real merge', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const wrapper = join(await tmp('holi-race-'), 'git')
    await writeFile(
      wrapper,
      `#!/bin/sh\ngit "$@"\nstatus=$?\nif [ "$1" = merge ] && [ $status -eq 0 ]; then\n  git -c maintenance.auto=false commit --amend --no-edit >/dev/null\n  git reflog delete 'HEAD@{1}'\nfi\nexit $status\n`,
    )
    await chmod(wrapper, 0o755)
    const records: Array<string | null> = []
    expect(
      (
        await openRepo(local, {
          gitPath: wrapper,
          commitProvenance: {
            begin: () => ({}),
            record: async (_ticket, _root, oid) => {
              records.push(oid)
            },
          },
        }).pull()
      ).kind,
    ).toBe('merged')
    expect(records).toEqual([null])
  })

  it('does not attribute a fast-forward or up-to-date pull', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'incoming.md', 'incoming\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const records: Array<string | null> = []
    const repo = openRepo(local, {
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
    expect((await repo.pull()).kind).toBe('merged')
    expect((await repo.pull()).kind).toBe('up-to-date')
    expect(records).toEqual([null, null])
  })
})
