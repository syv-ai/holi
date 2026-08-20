import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLocalOnlyPath } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SEED_STATE_FILE,
  mayRefresh,
  readSeedState,
  recordSeeded,
} from '../src/main/agent/seed-state'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-seed-state-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const SKILL = '.claude/skills/vault-apps/SKILL.md'

describe('the state file itself', () => {
  it('lives at .holi/seed-state.local.json and never syncs', () => {
    expect(SEED_STATE_FILE).toBe('.holi/seed-state.local.json')
    expect(isLocalOnlyPath(SEED_STATE_FILE)).toBe(true)
  })

  it('reads as empty when it does not exist', async () => {
    expect(await readSeedState(await tempDir())).toEqual({})
  })

  it('reads as empty rather than throwing when it is corrupt', async () => {
    const root = await tempDir()
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(join(root, SEED_STATE_FILE), '{ not json')
    expect(await readSeedState(root)).toEqual({})
  })

  it('records a hash, not the content', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    const state = await readSeedState(root)
    expect(Object.keys(state)).toEqual([SKILL])
    expect(state[SKILL]).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(join(root, SEED_STATE_FILE), 'utf8')).not.toContain('hello')
  })

  it('keeps earlier records when a later one is written', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# a\n')
    await recordSeeded(root, '.claude/hooks/x.mjs', '# b\n')
    expect(Object.keys(await readSeedState(root)).sort()).toEqual([
      '.claude/hooks/x.mjs',
      SKILL,
    ])
  })
})

describe('mayRefresh', () => {
  it('is true when the file on disk is exactly what Holi last wrote', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    expect(await mayRefresh(root, SKILL, '# hello\n')).toBe(true)
  })

  it('is false when somebody edited the file', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    expect(await mayRefresh(root, SKILL, '# hello, and my own note\n')).toBe(false)
  })

  it('is false with no record at all — the file is assumed to be the user\'s', async () => {
    // Every vault that exists today is in exactly this state. A `true` here
    // rewrites everyone's edited skills once, silently, on the next open.
    const root = await tempDir()
    expect(await mayRefresh(root, SKILL, '# hello\n')).toBe(false)
  })

  it('is false for a path recorded under a different name', async () => {
    const root = await tempDir()
    await recordSeeded(root, '.claude/hooks/x.mjs', '# hello\n')
    expect(await mayRefresh(root, SKILL, '# hello\n')).toBe(false)
  })

  it('is true again after re-recording the edit as ours', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    await recordSeeded(root, SKILL, '# v2\n')
    expect(await mayRefresh(root, SKILL, '# v2\n')).toBe(true)
    expect(await mayRefresh(root, SKILL, '# hello\n')).toBe(false)
  })
})
