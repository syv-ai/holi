/**
 * The disk half of the vault's settings, and the large-file gate's view of it.
 *
 * The parsing/merging/defaulting itself is `@holi/shared`'s `resolveVaultSettings`
 * and is tested there on strings. What is tested here is the part that only
 * exists on disk: that BOTH files are read, that the local one wins per key, and
 * that `readMaxCommittedFileBytes` still answers exactly as it did when it had
 * its own hand-rolled `JSON.parse`.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HOOKS } from '../src/main/vault/hooks/transforms'
import { DEFAULT_MAX_COMMITTED_FILE_BYTES } from '../src/main/vault/large-files'
import { readVaultSettings, writeVaultSettings } from '../src/main/vault/settings'
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
    expect(hooks).toEqual({
      relink: false,
      'archive-done': true,
      'normalize-md': true,
      'scaffold-md': true,
      'memory-index': true,
    })
  })
})

describe('writeVaultSettings', () => {
  const settingsAt = async (root: string, file: string) =>
    JSON.parse(await readFile(join(root, '.holi', file), 'utf8'))

  it('creates the file when the vault has none', async () => {
    const root = await vault()
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, 'settings.json')).toEqual({ dailyNotes: false })
  })

  it('merges over what is already there, key by key', async () => {
    const root = await vault('{"landing":{"kind":"board"},"maxCommittedFileBytes":2048}')
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, 'settings.json')).toEqual({
      landing: { kind: 'board' },
      maxCommittedFileBytes: 2048,
      dailyNotes: false,
    })
  })

  it('leaves siblings it knows nothing about alone', async () => {
    // The reminder delivery watermark lives in the local file. A settings write
    // that dropped it would re-fire every reminder the vault has ever fired.
    const root = await vault(undefined, '{"reminders":{"a.md":"2026-08-22T09:00"}}')
    await writeVaultSettings(root, { local: { colorScheme: 'dark' } })
    expect(await settingsAt(root, 'settings.local.json')).toEqual({
      reminders: { 'a.md': '2026-08-22T09:00' },
      colorScheme: 'dark',
    })
  })

  it('merges the hooks block per transform', async () => {
    const root = await vault('{"hooks":{"relink":true,"normalize-md":true}}')
    await writeVaultSettings(root, { committed: { hooks: { 'archive-done': true } } })
    expect((await settingsAt(root, 'settings.json')).hooks).toEqual({
      relink: true,
      'normalize-md': true,
      'archive-done': true,
    })
  })

  it('writes to one file without touching the other', async () => {
    const root = await vault('{"dailyNotes":true}', '{"colorScheme":"light"}')
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, 'settings.json')).toEqual({ dailyNotes: false })
    expect(await settingsAt(root, 'settings.local.json')).toEqual({ colorScheme: 'light' })
  })

  it('writes both files in one call', async () => {
    const root = await vault()
    await writeVaultSettings(root, {
      committed: { landing: { kind: 'board' } },
      local: { colorScheme: 'dark' },
    })
    expect(await settingsAt(root, 'settings.json')).toEqual({ landing: { kind: 'board' } })
    expect(await settingsAt(root, 'settings.local.json')).toEqual({ colorScheme: 'dark' })
  })

  it('leaves no .tmp file behind', async () => {
    // Atomic rename, copied from reminders/delivered-log.ts. A surviving .tmp
    // in `.holi` would be committed and synced to everyone.
    const root = await vault('{"dailyNotes":true}')
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    const entries = await readdir(join(root, '.holi'))
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })

  it('replaces a corrupt file rather than refusing to write', async () => {
    const root = await vault('{ not json')
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, 'settings.json')).toEqual({ dailyNotes: false })
  })

  it('does nothing at all when given nothing', async () => {
    const root = await vault()
    await writeVaultSettings(root, {})
    await expect(readFile(join(root, '.holi', 'settings.json'), 'utf8')).rejects.toThrow()
  })

  it('round-trips through the reader', async () => {
    const root = await vault()
    await writeVaultSettings(root, {
      committed: { landing: { kind: 'agenda' }, dailyNotes: false },
      local: { colorScheme: 'dark' },
    })
    const s = await readVaultSettings(root)
    expect(s.landing).toEqual({ kind: 'agenda' })
    expect(s.dailyNotes).toBe(false)
    expect(s.colorScheme).toBe('dark')
    expect(s.warnings).toEqual([])
  })
})
