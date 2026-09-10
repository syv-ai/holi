/**
 * Which transforms a vault has turned on.
 *
 * The settings file says **which**, and can never say **what** — that is D76's
 * security property, and the reason the hook body ships in the binary and lives
 * in `.git/hooks/` where nothing can push it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOOKS,
  VAULT_TRANSFORMS,
  readHookSettings,
} from '../src/main/vault/hooks/transforms'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-hooksettings-'))
  dirs.push(root)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function settings(json: string): Promise<void> {
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  await writeFile(join(root, '.holi/settings/app.yaml'), json, 'utf8')
}

describe('the transform set', () => {
  it('is a short list in a fixed order, and this is not a hook framework', () => {
    // `scaffold-md` sits before `normalize-md` so the block it writes is tidied
    // by the same pass as everything else.
    expect(VAULT_TRANSFORMS.map((t) => t.name)).toEqual([
      'relink',
      'archive-done',
      'scaffold-md',
      'normalize-md',
      // Last, and for its own reason: it is the only transform that reads the
      // whole TREE rather than the staged set, so it has to see what the four
      // before it left behind (D89).
      'memory-index',
    ])
  })

  it('defaults archive-done OFF and the rest on', () => {
    // It moves task files, which changes what the board shows. A transform that
    // rearranges someone's work is opt-in. `scaffold-md` writes visible lines and
    // is on anyway: it only ever fires on a file's first commit.
    expect(DEFAULT_HOOKS).toEqual({
      relink: true,
      'archive-done': false,
      'normalize-md': true,
      'scaffold-md': true,
      // On for relink's reason: it only ever rewrites a file it generated, and
      // that file says it is generated on its first line.
      'memory-index': true,
    })
  })

  it('keys the settings by the transform name, kebab and all', () => {
    // A camelCase settings key beside a kebab transform name is a mapping table
    // that exists only to be got wrong once.
    for (const transform of VAULT_TRANSFORMS) {
      expect(Object.keys(DEFAULT_HOOKS)).toContain(transform.name)
    }
  })
})

describe('readHookSettings', () => {
  it('uses the defaults when there is no settings file', async () => {
    expect(await readHookSettings(root)).toEqual(DEFAULT_HOOKS)
  })

  it('lets a vault turn one on', async () => {
    await settings(JSON.stringify({ hooks: { 'archive-done': true } }))
    expect(await readHookSettings(root)).toEqual({ ...DEFAULT_HOOKS, 'archive-done': true })
  })

  it('lets a vault turn one off', async () => {
    await settings(JSON.stringify({ hooks: { relink: false } }))
    expect((await readHookSettings(root)).relink).toBe(false)
  })

  it('keeps unrelated settings out of it', async () => {
    await settings(JSON.stringify({ maxCommittedFileBytes: 500, hooks: { relink: false } }))
    expect(await readHookSettings(root)).toEqual({ ...DEFAULT_HOOKS, relink: false })
  })

  it('falls back to the defaults on malformed JSON, not to everything-off', async () => {
    // A typo in an unrelated key must not silently stop link rewriting.
    await settings('{ not json')
    expect(await readHookSettings(root)).toEqual(DEFAULT_HOOKS)
  })

  it('ignores a non-boolean value rather than coercing it', async () => {
    await settings(JSON.stringify({ hooks: { relink: 'yes', 'archive-done': 1 } }))
    expect(await readHookSettings(root)).toEqual(DEFAULT_HOOKS)
  })

  it('ignores a key that is not a transform', async () => {
    await settings(JSON.stringify({ hooks: { 'rm-rf': true, relink: false } }))
    const result = await readHookSettings(root)
    expect(result).toEqual({ ...DEFAULT_HOOKS, relink: false })
    expect(Object.keys(result)).not.toContain('rm-rf')
  })

  it('ignores a hooks value that is not an object', async () => {
    await settings(JSON.stringify({ hooks: 'all' }))
    expect(await readHookSettings(root)).toEqual(DEFAULT_HOOKS)
  })

  it('cannot be told what a transform IS, only whether it runs', async () => {
    // The whole of D76 part 1 in one assertion: a command in the settings file
    // is data nobody reads, not code anybody runs.
    await settings(JSON.stringify({ hooks: { relink: { command: 'rm -rf /' } } }))
    expect(await readHookSettings(root)).toEqual(DEFAULT_HOOKS)
  })
})
