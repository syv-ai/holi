/**
 * The disk half of the vault's settings, and the large-file gate's view of it.
 *
 * The parsing/merging/defaulting itself is `@holi/shared`'s `resolveVaultSettings`
 * and is tested there on strings. What is tested here is the part that only
 * exists on disk: that BOTH files are read, that the local one wins per key, and
 * that `readMaxCommittedFileBytes` still answers exactly as it did when it had
 * its own hand-rolled `JSON.parse`.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HOOKS } from '../src/main/vault/hooks/transforms'
import { DEFAULT_MAX_COMMITTED_FILE_BYTES } from '../src/main/vault/large-files'
import { readVaultSettings } from '../src/main/vault/settings'
import { readMaxCommittedFileBytes } from '../src/main/vault/vault-settings'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function vault(settings?: string, local?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-vs-'))
  dirs.push(root)
  if (settings !== undefined || local !== undefined) {
    await mkdir(join(root, '.holi'), { recursive: true })
  }
  if (settings !== undefined) {
    await writeFile(join(root, '.holi', 'settings.json'), settings, 'utf8')
  }
  if (local !== undefined) {
    await writeFile(join(root, '.holi', 'settings.local.json'), local, 'utf8')
  }
  return root
}

describe('readMaxCommittedFileBytes', () => {
  it('defaults when there is no settings file', async () => {
    expect(await readMaxCommittedFileBytes(await vault())).toBe(DEFAULT_MAX_COMMITTED_FILE_BYTES)
  })

  it('reads a valid positive integer', async () => {
    expect(await readMaxCommittedFileBytes(await vault('{"maxCommittedFileBytes": 5242880}'))).toBe(
      5_242_880,
    )
  })

  it('defaults on malformed JSON', async () => {
    expect(await readMaxCommittedFileBytes(await vault('{ not json'))).toBe(
      DEFAULT_MAX_COMMITTED_FILE_BYTES,
    )
  })

  it('defaults when the key is missing, non-numeric, or not positive', async () => {
    for (const s of ['{}', '{"maxCommittedFileBytes": "big"}', '{"maxCommittedFileBytes": 0}', '{"maxCommittedFileBytes": -5}']) {
      expect(await readMaxCommittedFileBytes(await vault(s))).toBe(DEFAULT_MAX_COMMITTED_FILE_BYTES)
    }
  })
})

describe('readVaultSettings', () => {
  it('resolves to the defaults in a vault with no settings files', async () => {
    const s = await readVaultSettings(await vault())
    expect(s.landing).toEqual({ kind: 'daily' })
    expect(s.dailyNotes).toBe(true)
    expect(s.hooks).toEqual(DEFAULT_HOOKS)
    expect(s.warnings).toEqual([])
  })

  it('reads the committed file', async () => {
    const s = await readVaultSettings(await vault('{"landing":{"kind":"board"}}'))
    expect(s.landing).toEqual({ kind: 'board' })
  })

  it('lets the local file override the committed one, per key', async () => {
    const s = await readVaultSettings(
      await vault(
        '{"landing":{"kind":"board"},"dailyNotes":false}',
        '{"landing":{"kind":"agenda"}}',
      ),
    )
    expect(s.landing).toEqual({ kind: 'agenda' })
    // Untouched by a local file that says nothing about it.
    expect(s.dailyNotes).toBe(false)
  })

  it('reads a local file even when there is no committed one', async () => {
    const s = await readVaultSettings(await vault(undefined, '{"colorScheme":"light"}'))
    expect(s.colorScheme).toBe('light')
  })

  it('survives a directory where .holi is a file, not a folder', async () => {
    // Degrade, never throw: an unreadable path is the same as an absent one.
    const root = await mkdtemp(join(tmpdir(), 'holi-vs-'))
    dirs.push(root)
    await writeFile(join(root, '.holi'), 'not a directory', 'utf8')
    await expect(readVaultSettings(root)).resolves.toMatchObject({ dailyNotes: true })
  })
})

describe('a machine-local hooks override', () => {
  // NEW behaviour, and the one thing folding the readers together changed.
  // `readHookSettings` used to read `.holi/settings.json` alone, so the hooks
  // block was the only setting the `.local` layering did not reach.
  //
  // It is not a D76 concern: a local file is written by YOU, never pushed to
  // anyone, and can still only say *whether* one of Holi's own transforms runs —
  // never what one is. What it buys is keeping `archive-done` off on your laptop
  // while the vault you share with four other people says on.
  it('turns a transform off on this machine only', async () => {
    const root = await vault(
      '{"hooks":{"archive-done":true}}',
      '{"hooks":{"archive-done":false}}',
    )
    expect((await readVaultSettings(root)).hooks['archive-done']).toBe(false)
  })

  it('leaves the transforms the local file says nothing about alone', async () => {
    const root = await vault('{"hooks":{"relink":false}}', '{"hooks":{"archive-done":true}}')
    const { hooks } = await readVaultSettings(root)
    expect(hooks).toEqual({ relink: false, 'archive-done': true, 'normalize-md': true })
  })
})
