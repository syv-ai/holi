import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLocalOnlyPath } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SEED_STATE_FILE,
  readSeedState,
  recordSeeded,
  sha256,
  untouched,
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
  it('lives at .holi/state/seed-state.local.json and never syncs', () => {
    expect(SEED_STATE_FILE).toBe('.holi/state/seed-state.local.json')
    expect(isLocalOnlyPath(SEED_STATE_FILE)).toBe(true)
  })

  it('reads as empty when it does not exist', async () => {
    expect(await readSeedState(await tempDir())).toEqual({})
  })

  it('reads as empty rather than throwing when it is corrupt', async () => {
    const root = await tempDir()
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(join(root, SEED_STATE_FILE), '{ not json')
    expect(await readSeedState(root)).toEqual({})
  })

  it('records the text it wrote, the base an update merges against', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    expect(await readSeedState(root)).toEqual({
      [SKILL]: { sha: sha256('# hello\n'), text: '# hello\n' },
    })
  })

  it('reads a record from before the text was kept as its hash alone', async () => {
    const root = await tempDir()
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(join(root, SEED_STATE_FILE), JSON.stringify({ [SKILL]: sha256('# old\n') }))
    expect(await readSeedState(root)).toEqual({ [SKILL]: { sha: sha256('# old\n') } })
  })

  it('keeps earlier records when a later one is written', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# a\n')
    await recordSeeded(root, '.claude/hooks/x.mjs', '# b\n')
    expect(Object.keys(await readSeedState(root)).sort()).toEqual(['.claude/hooks/x.mjs', SKILL])
  })
})

describe('untouched', () => {
  it('is true when the file on disk is exactly what Holi last wrote', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    expect(untouched((await readSeedState(root))[SKILL], '# hello\n')).toBe(true)
  })

  it('is false when somebody edited the file', async () => {
    const root = await tempDir()
    await recordSeeded(root, SKILL, '# hello\n')
    expect(untouched((await readSeedState(root))[SKILL], '# hello, and mine\n')).toBe(false)
  })

  it('is false with no record at all', () => {
    expect(untouched(undefined, '# hello\n')).toBe(false)
  })
})
