/**
 * The large-file gate's pure core: which dirty paths commit, which are held back.
 * Pinned here so the size boundary and the deletions-always-commit rule can't
 * drift (docs/specs/2026-08-03-large-binary-policy-design.md).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_COMMITTED_FILE_BYTES,
  installGitHook,
  partitionBySize,
} from '../src/main/vault/large-files'

const exec = promisify(execFile)

describe('partitionBySize', () => {
  const THRESHOLD = 10_000
  const sizes: Record<string, number | null> = {
    'big.mp4': 20_000_000,
    'small.md': 100,
    'exactly.bin': THRESHOLD, // at the threshold, not over it
    'gone.md': null,
  }
  const sizeOf = (p: string) => sizes[p] ?? null

  it('holds back only files strictly over the threshold; deletions always commit', () => {
    const { commit, heldBack } = partitionBySize(
      ['big.mp4', 'small.md', 'exactly.bin', 'gone.md'],
      sizeOf,
      THRESHOLD,
    )
    // exactly-at-threshold commits (only strictly-over is held); a null size is a
    // deletion and always commits (it shrinks history, never grows it).
    expect(commit.sort()).toEqual(['exactly.bin', 'gone.md', 'small.md'])
    expect(heldBack).toEqual([{ path: 'big.mp4', bytes: 20_000_000 }])
  })

  it('returns two empty sets for no dirty paths', () => {
    expect(partitionBySize([], sizeOf, 10)).toEqual({ commit: [], heldBack: [] })
  })

  it('defaults the threshold to 10 MB', () => {
    expect(DEFAULT_MAX_COMMITTED_FILE_BYTES).toBe(10 * 1024 * 1024)
  })
})

describe('installGitHook (the agent-facing pre-commit gate)', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'holi-hook-'))
    dirs.push(dir)
    await exec('git', ['init', '-b', 'main', dir])
    await exec('git', ['-C', dir, 'config', 'user.email', 'a@b.c'])
    await exec('git', ['-C', dir, 'config', 'user.name', 'Test'])
    return dir
  }

  it('writes an executable pre-commit hook', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)
    const mode = (await stat(join(dir, '.git', 'hooks', 'pre-commit'))).mode
    expect(mode & 0o111).toBeGreaterThan(0) // some executable bit is set
  })

  it('rejects a commit that stages a file over the threshold', async () => {
    const dir = await repo()
    await installGitHook(dir, 100)
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(200), 'utf8')
    await exec('git', ['-C', dir, 'add', 'big.bin'])
    // git returns the hook's non-zero exit; the message names the offending file.
    await expect(exec('git', ['-C', dir, 'commit', '-m', 'x'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('big.bin'),
    })
  })

  it('allows a commit when every staged file is under the threshold', async () => {
    const dir = await repo()
    await installGitHook(dir, 100)
    await writeFile(join(dir, 'small.md'), 'hi\n', 'utf8')
    await exec('git', ['-C', dir, 'add', 'small.md'])
    await expect(exec('git', ['-C', dir, 'commit', '-m', 'x'])).resolves.toBeDefined()
  })

  it('is overridable with --no-verify (the deliberate escape)', async () => {
    const dir = await repo()
    await installGitHook(dir, 100)
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(200), 'utf8')
    await exec('git', ['-C', dir, 'add', 'big.bin'])
    await expect(
      exec('git', ['-C', dir, 'commit', '--no-verify', '-m', 'x']),
    ).resolves.toBeDefined()
  })
})
