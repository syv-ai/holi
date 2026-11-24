import { mkdtemp, rm, writeFile, mkdir, rename, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareRevisions } from '../src/main/vault/compare-revisions'

const exec = promisify(execFile)
const roots: string[] = []
async function repository(format = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'holi-revisions-'))
  roots.push(root)
  await exec('git', ['init', '-q', `--object-format=${format}`, root])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
  await exec('git', ['-C', root, 'config', 'tag.gpgsign', 'false'])
  return root
}
async function commit(root: string, message: string) {
  await exec('git', ['-C', root, 'add', '-A'])
  await exec('git', ['-C', root, 'commit', '-qm', message])
  return (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    const pids = await readFile(join(root, 'proxy-pids'), 'utf8').catch(() => '')
    for (const pid of pids.trim().split('\n').filter(Boolean).map(Number)) {
      const command = await exec('/bin/ps', ['-p', String(pid), '-o', 'args=']).then(
        (result) => result.stdout,
        () => '',
      )
      if (command.includes(root)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe('compareRevisions', () => {
  it('compares exact non-adjacent snapshots, preserving empty content and newlines', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), '')
    const first = await commit(root, 'empty')
    await writeFile(join(root, 'note.md'), 'intermediate')
    await commit(root, 'middle')
    await writeFile(join(root, 'note.md'), 'last\n\n')
    const last = await commit(root, 'last')
    await expect(compareRevisions(root, 'note.md', first, last)).resolves.toEqual({
      kind: 'text',
      before: '',
      after: 'last\n\n',
    })
  })

  it('compares snapshots in a SHA-256 repository', async () => {
    const root = await repository('sha256')
    await writeFile(join(root, 'note.md'), 'before')
    const before = await commit(root, 'first')
    await writeFile(join(root, 'note.md'), 'after')
    const after = await commit(root, 'second')
    await expect(compareRevisions(root, 'note.md', before, after)).resolves.toEqual({
      kind: 'text',
      before: 'before',
      after: 'after',
    })
  })

  it('reports a missing historical blob without using the working copy', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), 'still on disk')
    const sha = await commit(root, 'first')
    const blob = (await exec('git', ['-C', root, 'rev-parse', `${sha}:note.md`])).stdout.trim()
    await rm(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
    await expect(compareRevisions(root, 'note.md', sha, sha)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
  })

  it.each(['root', 'nested'])('reports a missing %s tree as unavailable history', async (which) => {
    const root = await repository()
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'note.md'), 'nested text\n')
    const sha = await commit(root, 'nested snapshot')
    await expect(compareRevisions(root, 'folder/note.md', sha, sha)).resolves.toEqual({
      kind: 'text',
      before: 'nested text\n',
      after: 'nested text\n',
    })
    const revision = which === 'root' ? `${sha}^{tree}` : `${sha}:folder`
    const tree = (await exec('git', ['-C', root, 'rev-parse', revision])).stdout.trim()
    await rm(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)))
    await expect(compareRevisions(root, 'folder/note.md', sha, sha)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
  })

  it('never fetches a missing promisor blob through a reachable transport', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), 'promised content')
    const sha = await commit(root, 'promisor snapshot')
    const blob = (await exec('git', ['-C', root, 'rev-parse', `${sha}:note.md`])).stdout.trim()
    await rm(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
    const bin = join(root, 'bin')
    await mkdir(bin)
    const marker = join(root, 'fetch-attempt')
    const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`
    await writeFile(
      join(bin, 'git-remote-holi-test'),
      `#!/bin/sh\nprintf attempted > ${quotedMarker}\nexit 1\n`,
      { mode: 0o700 },
    )
    for (const [key, value] of [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'origin'],
      ['remote.origin.url', 'holi-test::fixture'],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', 'blob:none'],
      ['protocol.holi-test.allow', 'always'],
    ])
      await exec('git', ['-C', root, 'config', key!, value!])
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    // Positive control proves this repository would use the transport for the same missing blob.
    await expect(
      exec('git', ['-C', root, 'cat-file', '-p', blob], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: '0' },
      }),
    ).rejects.toBeDefined()
    expect(await readFile(marker, 'utf8')).toBe('attempted')
    await rm(marker)
    await expect(compareRevisions(root, 'note.md', sha, sha)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves content equal to the old sentinel and ignores replacement refs', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), 'unsupported')
    const original = await commit(root, 'original')
    await writeFile(join(root, 'note.md'), 'replacement')
    const replacement = await commit(root, 'replacement')
    await exec('git', ['-C', root, 'replace', original, replacement])
    await expect(compareRevisions(root, 'note.md', original, original)).resolves.toEqual({
      kind: 'text',
      before: 'unsupported',
      after: 'unsupported',
    })
  })

  it('does not infer comparisons for renamed or deleted paths', async () => {
    const root = await repository()
    await writeFile(join(root, 'old.md'), 'original\n')
    const before = await commit(root, 'original')
    await rename(join(root, 'old.md'), join(root, 'new.md'))
    const renamed = await commit(root, 'rename')
    await rm(join(root, 'new.md'))
    const deleted = await commit(root, 'delete')
    for (const [path, start, end] of [
      ['old.md', before, renamed],
      ['new.md', before, renamed],
      ['new.md', renamed, deleted],
    ]) {
      await expect(compareRevisions(root, path, start, end)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'missing',
      })
    }
  })

  it('rejects symlinks, gitlinks and non-commit endpoints without following them', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), 'target')
    const first = await commit(root, 'regular')
    const blob = (await exec('git', ['-C', root, 'rev-parse', `${first}:note.md`])).stdout.trim()
    await exec('git', [
      '-C',
      root,
      'update-index',
      '--add',
      '--cacheinfo',
      `120000,${blob},link.md`,
    ])
    await exec('git', [
      '-C',
      root,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${first},nested`,
    ])
    await exec('git', ['-C', root, 'commit', '-qm', 'special entries'])
    const special = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    for (const path of ['link.md', 'nested']) {
      await expect(compareRevisions(root, path, special, special)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'unsupported',
      })
    }
    await expect(compareRevisions(root, 'note.md', blob, first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await exec('git', ['-C', root, 'tag', '-am', 'tag', 'annotated', first])
    const tag = (await exec('git', ['-C', root, 'rev-parse', 'annotated'])).stdout.trim()
    await expect(compareRevisions(root, 'note.md', tag, first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    })
  })

  it('preserves UTF-8 text and literal pathspec characters while bounding unsupported content', async () => {
    const root = await repository()
    const text = '\ufeffæøå\n'
    await writeFile(join(root, 'a[1].md'), text)
    await writeFile(join(root, 'a1.md'), 'not this file')
    await writeFile(join(root, 'large.md'), Buffer.alloc(1024 * 1024 + 1, 65))
    await writeFile(join(root, 'binary.md'), Buffer.from([0, 65]))
    await writeFile(join(root, 'invalid.md'), Buffer.from([0xff]))
    const sha = await commit(root, 'content boundaries')
    await expect(compareRevisions(root, 'a[1].md', sha.toUpperCase(), sha)).resolves.toEqual({
      kind: 'text',
      before: text,
      after: text,
    })
    await expect(compareRevisions(root, 'large.md', sha, sha)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'limit',
    })
    for (const path of ['binary.md', 'invalid.md']) {
      await expect(compareRevisions(root, path, sha, sha)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'unsupported',
      })
    }
    await expect(
      compareRevisions(join(root, 'absent-repository'), 'a[1].md', sha, sha),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'error',
    })
  })

  it.skipIf(process.platform === 'win32').each(['unresponsive', 'successive'])(
    'bounds %s Git processes with one comparison deadline',
    async (mode) => {
      const root = await repository()
      await writeFile(join(root, 'note.md'), 'bounded text')
      const sha = await commit(root, 'snapshot')
      const realGit = (await exec('/usr/bin/which', ['git'])).stdout.trim()
      const bin = join(root, 'bin')
      await mkdir(bin)
      const pids = join(root, 'proxy-pids')
      // Model an unresponsive executable or delay genuine Git; no Git results are fabricated.
      await writeFile(
        join(bin, 'git'),
        `#!/usr/bin/env node
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const record = pid => fs.appendFileSync(${JSON.stringify(pids)}, String(pid) + '\\n')
record(process.pid)
if (${JSON.stringify(mode)} === 'unresponsive') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else {
  setTimeout(() => {
    const child = spawn(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] })
    if (child.pid) record(child.pid)
    child.stdin.on('error', () => {})
    process.stdin.pipe(child.stdin)
    child.on('error', () => process.exit(1))
    child.on('exit', code => process.exit(code ?? 1))
  }, 800)
}
`,
        { mode: 0o700 },
      )
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
      await expect(compareRevisions(root, 'note.md', sha, sha)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'limit',
      })
      const owned = (await readFile(pids, 'utf8')).trim().split('\n').map(Number)
      await vi.waitFor(() => {
        for (const pid of owned) {
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        }
      })
    },
    15_000,
  )

  it('reports absent paths and rejects unsupported entries and invalid endpoints', async () => {
    const root = await repository()
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'inside'), 'x')
    const first = await commit(root, 'tree')
    await expect(compareRevisions(root, 'absent.md', first, first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
    await expect(compareRevisions(root, 'folder', first, first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await expect(compareRevisions(root, 'folder/inside', 'f'.repeat(40), first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
    await expect(compareRevisions(root, '../note.md', first, first)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await expect(compareRevisions(root, '.env', first, first)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await expect(compareRevisions(root, 'x', 'HEAD', first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    })
  })
})
