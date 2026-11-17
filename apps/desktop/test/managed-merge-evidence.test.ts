import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { traceHasOnlyManagedBuiltins } from '../src/main/git-provenance-evidence'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
  tmp,
} from './helpers/git-fixtures'

afterAll(cleanupFixtures)

function maintenanceTrace(option: string | null): string {
  const argv = ['git', 'maintenance', 'run', '--auto', '--no-quiet', ...(option ? [option] : [])]
  return (
    [
      { event: 'start', sid: 'root' },
      { event: 'cmd_name', sid: 'root', name: 'merge' },
      { event: 'child_start', sid: 'root', child_id: 1, use_shell: false, argv },
      { event: 'start', sid: 'root/stamp-P0000007b' },
      { event: 'cmd_name', sid: 'root/stamp-P0000007b', name: 'maintenance' },
      { event: 'exit', sid: 'root/stamp-P0000007b', code: 0 },
      { event: 'child_exit', sid: 'root', child_id: 1, pid: 123, code: 0 },
      { event: 'exit', sid: 'root', code: 0 },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n'
  )
}

describe('managed merge evidence', () => {
  it.each([['--detach'], ['--no-detach'], [null]] as const)(
    'accepts parser fixture maintenance argv variant %s',
    (option) => {
      expect(traceHasOnlyManagedBuiltins(maintenanceTrace(option), 'merge', 0)).toBe(true)
    },
  )

  it('rejects detached incomplete maintenance evidence without waiting', () => {
    const trace = maintenanceTrace('--detach').split('\n').slice(0, -3).join('\n') + '\n'
    expect(traceHasOnlyManagedBuiltins(trace, 'merge', 0)).toBe(false)
  })
  it('fails closed when a post-merge hook amends HEAD and deletes the evidence reflog', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const hook = join(local, '.git/hooks/post-merge')
    await writeFile(
      hook,
      `#!/bin/sh\nset -eu\ntouch .git/post-merge-ran\ngit commit --amend --no-edit >/dev/null\ngit reflog delete 'HEAD@{1}'\n`,
    )
    await chmod(hook, 0o755)
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
    const parents = (await plainGit(local, ['--no-replace-objects', 'cat-file', '-p', 'HEAD']))
      .split('\n\n')[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '))
    expect(parents).toHaveLength(2)
    expect(await plainGit(local, ['status', '--porcelain'])).toBe('')
    expect(records).toEqual([null])
  })

  it.each(['prepare-commit-msg', 'reference-transaction', 'post-commit'] as const)(
    'fails closed when a %s hook participates in an auto-settled merge',
    async (name) => {
      const remote = await makeRemote()
      const local = await makeClone(remote, 'local')
      const teammate = await makeClone(remote, 'teammate')
      await commitFile(local, 'README.md', 'locally modified\n')
      await plainGit(teammate, ['rm', 'README.md'])
      await plainGit(teammate, ['commit', '-m', 'delete note'])
      await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
      const hook = join(local, '.git/hooks', name)
      await writeFile(
        hook,
        name === 'post-commit'
          ? "#!/bin/sh\nset -eu\nif [ ! -e .git/post-commit-once ]; then touch .git/post-commit-once; git commit --amend --no-edit >/dev/null; git reflog delete 'HEAD@{1}'; fi\n"
          : '#!/bin/sh\nexit 0\n',
      )
      await chmod(hook, 0o755)
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
      expect(records).toEqual([null])
    },
  )

  it.each(['reflog', 'object'] as const)(
    'bounds missing merge evidence from the %s probe without retry',
    async (probe) => {
      const remote = await makeRemote()
      const local = await makeClone(remote, 'local')
      const teammate = await makeClone(remote, 'teammate')
      await commitFile(local, 'ours.md', 'ours\n')
      await commitFile(teammate, 'theirs.md', 'theirs\n')
      await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
      const dir = await tmp('holi-merge-evidence-')
      const script = join(dir, 'git')
      const calls = join(dir, 'calls')
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s\n' "$*" >> "$EVIDENCE_CALLS"\ncase " $* " in\n  ${probe === 'reflog' ? '*" reflog "*' : '*" cat-file -p "*'}) touch "$EVIDENCE_FIRED"; exit 1 ;;\nesac\nexec git "$@"\n`,
      )
      await chmod(script, 0o755)
      const records: Array<string | null> = []
      const result = await openRepo(local, {
        gitPath: script,
        env: { EVIDENCE_CALLS: calls, EVIDENCE_FIRED: join(dir, 'fired') },
        commitProvenance: {
          begin: () => ({}),
          record: async (_ticket, _root, oid) => {
            records.push(oid)
          },
        },
      }).pull()
      expect(result.kind).toBe('merged')
      expect(records).toEqual([null])
      await expect(access(join(dir, 'fired'))).resolves.toBeUndefined()
      const commands = (await readFile(calls, 'utf8')).trim().split('\n')
      expect(commands.filter((line) => /(?:^| )merge(?: |$)/.test(line))).toHaveLength(1)
    },
  )

  it.each(['reflog', 'object', 'rev-parse'] as const)(
    'fails closed when the %s evidence read overflows',
    async (probe) => {
      const remote = await makeRemote()
      const local = await makeClone(remote, 'local')
      const teammate = await makeClone(remote, 'teammate')
      await commitFile(local, 'ours.md', 'ours\n')
      await commitFile(teammate, 'theirs.md', 'theirs\n')
      await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
      const dir = await tmp('holi-merge-evidence-limit-')
      const script = join(dir, 'git')
      const calls = join(dir, 'calls')
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s\n' "$*" >> "$EVIDENCE_CALLS"\nif [ "$1" = merge ]; then git "$@"; status=$?; touch "$EVIDENCE_ROOT/.git/merge-landed"; exit "$status"; fi\ncase " $* " in\n  *--no-replace-objects*${probe === 'reflog' ? '*reflog*' : probe === 'object' ? '*"cat-file -p"*' : '*rev-parse*'})\n    if [ -f "$EVIDENCE_ROOT/.git/merge-landed" ]; then touch "$EVIDENCE_FIRED"; head -c 2097152 /dev/zero | tr '\\000' x; exit 0; fi\n    ;;\nesac\nexec git "$@"\n`,
      )
      await chmod(script, 0o755)
      const records: Array<string | null> = []
      expect(
        (
          await openRepo(local, {
            gitPath: script,
            env: {
              EVIDENCE_ROOT: local,
              EVIDENCE_CALLS: calls,
              EVIDENCE_FIRED: join(dir, 'fired'),
            },
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
      await expect(access(join(dir, 'fired'))).resolves.toBeUndefined()
      expect(
        (await readFile(calls, 'utf8'))
          .split('\n')
          .filter((line) => /(?:^| )merge(?: |$)/.test(line)),
      ).toHaveLength(1)
    },
  )

  it('keeps a successful merge when rev-parse evidence fails', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const dir = await tmp('holi-merge-rev-parse-failure-')
    const script = join(dir, 'git')
    const calls = join(dir, 'calls')
    await writeFile(
      script,
      `#!/bin/sh\nprintf '%s\n' "$*" >> "$EVIDENCE_CALLS"\nif [ "$1" = merge ]; then git "$@"; status=$?; touch "$EVIDENCE_ROOT/.git/merge-landed"; exit "$status"; fi\ncase " $* " in *--no-replace-objects*rev-parse*) if [ -f "$EVIDENCE_ROOT/.git/merge-landed" ]; then exit 1; fi;; esac\nexec git "$@"\n`,
    )
    await chmod(script, 0o755)
    const records: Array<string | null> = []
    expect(
      (
        await openRepo(local, {
          gitPath: script,
          env: { EVIDENCE_ROOT: local, EVIDENCE_CALLS: calls },
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
    expect(
      (await readFile(calls, 'utf8'))
        .split('\n')
        .some((line) => line.includes('--no-replace-objects rev-parse')),
    ).toBe(true)
  })

  it('bounds a timed-out evidence read without failing the merge', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const dir = await tmp('holi-merge-timeout-')
    const script = join(dir, 'git')
    await writeFile(
      script,
      '#!/bin/sh\nif [ "$1" = merge ]; then git "$@"; status=$?; touch "$EVIDENCE_ROOT/.git/merge-landed"; exit "$status"; fi\ncase " $* " in *--no-replace-objects*rev-parse*) if [ -f "$EVIDENCE_ROOT/.git/merge-landed" ]; then touch "$EVIDENCE_FIRED"; exec sleep 10; fi;; esac\nexec git "$@"\n',
    )
    await chmod(script, 0o755)
    const records: Array<string | null> = []
    const started = Date.now()
    expect(
      (
        await openRepo(local, {
          gitPath: script,
          env: { EVIDENCE_ROOT: local, EVIDENCE_FIRED: join(dir, 'fired') },
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
    await expect(access(join(dir, 'fired'))).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(8000)
  }, 15000)

  it.each(['missing', 'truncated', 'malformed'] as const)(
    'fails closed with %s Trace2 evidence',
    async (trace) => {
      const remote = await makeRemote()
      const local = await makeClone(remote, 'local')
      const teammate = await makeClone(remote, 'teammate')
      await commitFile(local, 'ours.md', 'ours\n')
      await commitFile(teammate, 'theirs.md', 'theirs\n')
      await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
      const dir = await tmp('holi-merge-trace-')
      const script = join(dir, 'git')
      const calls = join(dir, 'calls')
      const traceOut =
        trace === 'missing'
          ? 'unset GIT_TRACE2_EVENT; exec git "$@" 3>&-'
          : `git "$@" 3>&3\nstatus=$?\n${trace === 'truncated' ? 'printf \'{\\"event\\":\\"start\\"\' >&3' : 'printf \'{\\"event\\":\\"start\\",\\"sid\\":\\"forged\\"}\n\' >&3'}\nexit $status`
      await writeFile(script, `#!/bin/sh\nprintf '%s\n' "$*" >> "$EVIDENCE_CALLS"\n${traceOut}\n`)
      await chmod(script, 0o755)
      const records: Array<string | null> = []
      expect(
        (
          await openRepo(local, {
            gitPath: script,
            env: { EVIDENCE_CALLS: calls },
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
    },
  )

  it('rejects post-merge hooks even when they append forged clean Trace2 events', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    await writeFile(
      join(local, '.git/hooks/post-merge'),
      `#!/bin/sh\nset -eu\n[ "$GIT_TRACE2_EVENT" = 3 ]\nprintf '{"event":"start","sid":"forged"}\n{"event":"cmd_name","sid":"forged","name":"merge"}\n{"event":"exit","sid":"forged","code":0}\n' >&3\n`,
      { mode: 0o755 },
    )
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
    expect(records).toEqual([null])
  })

  it('keeps settlement errors separate from sensitive Trace2 parameters', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'README.md', 'local edit\n')
    await plainGit(teammate, ['rm', 'README.md'])
    await plainGit(teammate, ['commit', '-m', 'delete note'])
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    await writeFile(
      join(local, '.git/hooks/prepare-commit-msg'),
      '#!/bin/sh\nprintf "settlement refused by hook\\n" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const records: Array<string | null> = []
    const error = await openRepo(local, {
      env: {
        GIT_TRACE2_ENV_VARS: 'HOLI_TEST_TRACE_VALUE',
        HOLI_TEST_TRACE_VALUE: 'synthetic-private-trace-value',
      },
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
      .pull()
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ stderr: expect.stringContaining('settlement refused by hook') })
    const diagnostic = String((error as Error).message) + (error as { stderr: string }).stderr
    expect(diagnostic).not.toContain('synthetic-private-trace-value')
    expect(diagnostic).not.toContain('"event":')
    expect(records).toEqual([null])
  })

  it('does not probe evidence when the recorder declines ownership at begin', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    const dir = await tmp('holi-merge-no-evidence-')
    const script = join(dir, 'git')
    const calls = join(dir, 'calls')
    await writeFile(script, '#!/bin/sh\nprintf \'%s\n\' "$*" >> "$EVIDENCE_CALLS"\nexec git "$@"\n')
    await chmod(script, 0o755)
    const records: Array<string | null> = []
    const repo = openRepo(local, {
      gitPath: script,
      env: { EVIDENCE_CALLS: calls },
      commitProvenance: {
        begin: () => null,
        record: async (_ticket, _root, oid) => {
          records.push(oid)
        },
      },
    })
    expect((await repo.pull()).kind).toBe('merged')
    expect(records).toEqual([])
    const commands = (await readFile(calls, 'utf8')).split('\n')
    expect(commands.some((line) => line.includes('--no-replace-objects'))).toBe(false)
    expect(commands.some((line) => /(?:^| )reflog(?: |$)/.test(line))).toBe(false)
    expect(commands.some((line) => line.includes('cat-file'))).toBe(false)
  })
})
