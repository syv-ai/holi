import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { cleanupFixtures, makeClone, makeRemote, plainGit, tmp } from './helpers/git-fixtures'

afterAll(cleanupFixtures)

describe('adversarial managed commit evidence', () => {
  it('does not let a replacement object hide an actual two-parent commit', async () => {
    const root = await makeClone(await makeRemote())
    await writeFile(
      join(root, '.git/hooks/post-commit'),
      `#!/bin/sh
set -eu
one=$(git rev-parse HEAD)
parent=$(git rev-parse HEAD^)
tree=$(git rev-parse 'HEAD^{tree}')
other=$(printf other | git commit-tree "$tree")
merge=$(printf merge | git commit-tree "$tree" -p "$parent" -p "$other")
git replace "$merge" "$one"
git update-ref -m "$GIT_REFLOG_ACTION: disguised" HEAD "$merge"
git reflog delete 'HEAD@{1}'
`,
      { mode: 0o755 },
    )
    const records: Array<string | null> = []
    await writeFile(join(root, 'note.md'), 'managed\n')
    const oid = await openRepo(root, {
      commitProvenance: {
        begin: () => ({}),
        record: async (_ticket, _root, exact) => {
          records.push(exact)
        },
      },
    }).commitAll('managed', ['note.md'])
    expect(
      (await plainGit(root, ['--no-replace-objects', 'cat-file', '-p', oid!]))
        .split('\n')
        .filter((line) => line.startsWith('parent ')),
    ).toHaveLength(2)
    expect(records).toEqual([null])
  })

  it.each([
    ['reflog', 'overflow'],
    ['reflog', 'timeout'],
    ['object', 'overflow'],
    ['object', 'timeout'],
  ] as const)(
    'bounds %s %s without retrying a successful commit',
    async (read, failure) => {
      const root = await makeClone(await makeRemote())
      const dir = await tmp('holi-evidence-exec-')
      const script = join(dir, 'git')
      const calls = join(dir, 'calls')
      // The wrapper delegates every mutation to real Git. Only the evidence read
      // misbehaves, after the commit has already succeeded.
      await writeFile(
        script,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$EVIDENCE_CALLS"
case " $* " in
  ${read === 'reflog' ? '*" reflog "*' : '*" cat-file -p "*'})
    if [ -f "$EVIDENCE_ROOT/.git/landed" ]; then
      ${failure === 'overflow' ? "head -c 2097152 /dev/zero | tr '\\000' x" : 'exec sleep 10'}
      exit 0
    fi
    ;;
esac
exec git "$@"
`,
      )
      await chmod(script, 0o755)
      await writeFile(join(root, '.git/hooks/post-commit'), '#!/bin/sh\ntouch .git/landed\n', {
        mode: 0o755,
      })
      const records: Array<string | null> = []
      await writeFile(join(root, 'note.md'), 'managed\n')
      const started = Date.now()
      const oid = await openRepo(root, {
        gitPath: script,
        env: { EVIDENCE_ROOT: root, EVIDENCE_CALLS: calls },
        commitProvenance: {
          begin: () => ({}),
          record: async (_ticket, _root, exact) => {
            records.push(exact)
          },
        },
      }).commitAll('managed', ['note.md'])
      expect(oid).toMatch(/^[0-9a-f]{40}$/)
      expect(records).toEqual([null])
      expect(Date.now() - started).toBeLessThan(4000)
      const commands = (await readFile(calls, 'utf8')).trim().split('\n')
      expect(commands.filter((line) => /(?:^| )commit(?: |$)/.test(line))).toHaveLength(1)
      expect(
        commands.filter((line) => line.includes('reflog')).every((line) => /-n\d+/.test(line)),
      ).toBe(true)
      expect(await plainGit(root, ['rev-list', '--count', 'HEAD'])).toBe('2')
    },
    15000,
  )
  it.each(['timeout', 'overflow'] as const)(
    'records unknown when only the final MERGE_HEAD probe has %s',
    async (failure) => {
      const root = await makeClone(await makeRemote())
      const dir = await tmp('holi-final-merge-head-')
      const script = join(dir, 'git')
      const calls = join(dir, 'calls')
      const fired = join(dir, 'fired')
      await writeFile(
        script,
        `#!/bin/sh
printf '%s\n' "$*" >> "$EVIDENCE_CALLS"
case " $* " in
  *'rev-parse --verify --quiet MERGE_HEAD'*)
    if [ -f "$EVIDENCE_ROOT/.git/commit-landed" ]; then
      touch "$EVIDENCE_FIRED"
      ${failure === 'overflow' ? "head -c 2097152 /dev/zero | tr '\\000' x; exit 0" : 'exec sleep 10'}
    fi
    ;;
esac
if [ "$1" = commit ]; then
  git "$@"
  status=$?
  touch "$EVIDENCE_ROOT/.git/commit-landed"
  exit "$status"
fi
exec git "$@"
`,
      )
      await chmod(script, 0o755)
      await writeFile(join(root, 'note.md'), 'managed\n')
      const records: Array<string | null> = []
      const oid = await openRepo(root, {
        gitPath: script,
        env: { EVIDENCE_ROOT: root, EVIDENCE_CALLS: calls, EVIDENCE_FIRED: fired },
        commitProvenance: {
          begin: () => ({}),
          record: async (_ticket, _root, exact) => records.push(exact),
        },
      }).commitAll('managed', ['note.md'])
      expect(oid).toMatch(/^[0-9a-f]{40}$/)
      expect(records).toEqual([null])
      await expect(access(fired)).resolves.toBeUndefined()
      const commands = (await readFile(calls, 'utf8')).trim().split('\n')
      expect(commands.filter((line) => /(?:^| )commit(?: |$)/.test(line))).toHaveLength(1)
      expect(commands.filter((line) => line.includes('MERGE_HEAD'))).toHaveLength(2)
    },
    15000,
  )
})
