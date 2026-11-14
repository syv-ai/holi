/**
 * The disk half of the vault's settings, and the large-file gate's view of it.
 *
 * The parsing/merging/defaulting itself is `@holi/shared`'s `resolveVaultSettings`
 * and is tested there on strings. What is tested here is the part that only
 * exists on disk: that BOTH files are read, that the local one wins per key, and
 * that `readMaxCommittedFileBytes` still answers exactly as it did when it had
 * its own hand-rolled `JSON.parse`.
 */
import { parse as parseYaml } from 'yaml'
import {
  PLUGINS_FILE,
  PLUGINS_LOCAL_FILE,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  VAULT_SETTING_DEFAULTS,
  pluginSettingValue,
  writePluginSettingsText,
  type PluginInfo,
} from '@holi/shared'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HOOKS } from '../src/main/vault/hooks/transforms'
import { DEFAULT_MAX_COMMITTED_FILE_BYTES } from '../src/main/vault/large-files'
import {
  readVaultSettings,
  writePluginSettings,
  writeVaultSettings,
} from '../src/main/vault/settings'
import { install } from '../src/main/plugin-host/installed'
import type { MainPlugin } from '../src/main/plugin-api'
import { GOOGLE_INFO } from '../src/plugins/google/info'
import { readMaxCommittedFileBytes } from '../src/main/vault/vault-settings'

const dirs: string[] = []

function installGoogleForSettingsTest(): void {
  install([
    {
      info: { id: 'agent', label: 'Agent', default: true, builtIn: true } as PluginInfo,
    } as MainPlugin,
    { info: GOOGLE_INFO } as MainPlugin,
  ])
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function vault(settings?: string, local?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-vs-'))
  dirs.push(root)
  if (settings !== undefined || local !== undefined) {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
  }
  if (settings !== undefined) {
    await writeFile(join(root, SETTINGS_FILE), settings, 'utf8')
  }
  if (local !== undefined) {
    await writeFile(join(root, SETTINGS_LOCAL_FILE), local, 'utf8')
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
    for (const s of [
      '{}',
      '{"maxCommittedFileBytes": "big"}',
      '{"maxCommittedFileBytes": 0}',
      '{"maxCommittedFileBytes": -5}',
    ]) {
      expect(await readMaxCommittedFileBytes(await vault(s))).toBe(DEFAULT_MAX_COMMITTED_FILE_BYTES)
    }
  })
})

describe('readVaultSettings', () => {
  it('resolves to the defaults in a vault with no settings files', async () => {
    const s = await readVaultSettings(await vault())
    expect(s.editorFont).toBe(VAULT_SETTING_DEFAULTS.editorFont)
    expect(s.dailyNotes).toBe(true)
    expect(s.hooks).toEqual(DEFAULT_HOOKS)
    expect(s.warnings).toEqual([])
  })

  it('reads the committed file', async () => {
    const s = await readVaultSettings(await vault('{"editorFont":"serif"}'))
    expect(s.editorFont).toBe('serif')
  })

  it('lets the local file override the committed one, per key', async () => {
    const s = await readVaultSettings(
      await vault('{"editorFont":"serif","dailyNotes":false}', '{"editorFont":"mono"}'),
    )
    expect(s.editorFont).toBe('mono')
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
  // `readHookSettings` used to read `.holi/settings/app.yaml` alone, so the hooks
  // block was the only setting the `.local` layering did not reach.
  //
  // It is not a hook-security concern: a local file is written by YOU, never pushed to
  // anyone, and can still only say *whether* one of Holi's own transforms runs —
  // never what one is. What it buys is keeping `archive-done` off on your laptop
  // while the vault you share with four other people says on.
  it('turns a transform off on this machine only', async () => {
    const root = await vault('{"hooks":{"archive-done":true}}', '{"hooks":{"archive-done":false}}')
    expect((await readVaultSettings(root)).hooks['archive-done']).toBe(false)
  })

  it('leaves the transforms the local file says nothing about alone', async () => {
    const root = await vault('{"hooks":{"relink":false}}', '{"hooks":{"archive-done":true}}')
    const { hooks } = await readVaultSettings(root)
    expect(hooks).toEqual({
      relink: false,
      'archive-done': true,
      'normalize-md': true,
      'shrink-images': true,
      'memory-index': true,
    })
  })
})

describe('Google remote image settings', () => {
  it.each([
    { committed: ['tracker@example.com'], local: undefined, expected: [] },
    {
      committed: ['tracker@example.com'],
      local: ['trusted@example.com'],
      expected: ['trusted@example.com'],
    },
    { committed: ['tracker@example.com'], local: [], expected: [] },
    { committed: undefined, local: undefined, expected: [] },
  ])(
    'resolves sender trust only from this machine: $local',
    async ({ committed, local, expected }) => {
      installGoogleForSettingsTest()
      const root = await vault()
      await mkdir(join(root, '.holi/settings'), { recursive: true })
      await writeFile(
        join(root, PLUGINS_FILE),
        JSON.stringify({
          google: { imagesFromAllSenders: false, imageSenders: committed },
        }),
      )
      if (local !== undefined) {
        await writeFile(
          join(root, PLUGINS_LOCAL_FILE),
          JSON.stringify({
            google: { imageSenders: local },
          }),
        )
      }
      const resolved = await readVaultSettings(root)
      expect(pluginSettingValue(resolved.pluginValues, GOOGLE_INFO, 'imagesFromAllSenders')).toBe(
        false,
      )
      expect(pluginSettingValue(resolved.pluginValues, GOOGLE_INFO, 'imageSenders')).toEqual(
        expected,
      )
    },
  )

  it('defaults missing and malformed global consent to false', async () => {
    installGoogleForSettingsTest()
    for (const [committed, local] of [
      [undefined, undefined],
      [undefined, 'google:\n  imagesFromAllSenders: invalid\n'],
    ]) {
      const settings = await readVaultSettings(await vault(committed, local))
      expect(pluginSettingValue(settings.pluginValues, GOOGLE_INFO, 'imagesFromAllSenders')).toBe(
        false,
      )
      expect(pluginSettingValue(settings.pluginValues, GOOGLE_INFO, 'imageSenders')).toEqual([])
    }
  })

  it('writes both machine-local Google image choices to plugins.local.yaml only', async () => {
    const root = await vault()
    const text = writePluginSettingsText(
      { google: { imagesFromAllSenders: true, imageSenders: ['one@example.com'] } },
      'local',
      [GOOGLE_INFO],
    )
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(join(root, PLUGINS_LOCAL_FILE), text, 'utf8')
    const saved = parseYaml(await readFile(join(root, PLUGINS_LOCAL_FILE), 'utf8')) as Record<
      string,
      unknown
    >
    expect(saved.google).toMatchObject({
      imagesFromAllSenders: true,
      imageSenders: ['one@example.com'],
    })
    await expect(readFile(join(root, PLUGINS_FILE), 'utf8')).rejects.toThrow()
    expect(saved.google).toEqual({ imagesFromAllSenders: true, imageSenders: ['one@example.com'] })
  })
})

describe('writeVaultSettings', () => {
  const settingsAt = async (root: string, file: string) =>
    parseYaml(await readFile(join(root, file), 'utf8'))

  it('creates the file when the vault has none', async () => {
    const root = await vault()
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, SETTINGS_FILE)).toEqual({ dailyNotes: false })
  })

  it('preserves an existing home selection when another setting changes', async () => {
    const root = await vault('home: board\neditorFont: serif\n')

    const before = await readVaultSettings(root)
    expect(before.editorFont).toBe('serif')

    await writeVaultSettings(root, { committed: { dailyNotes: false } })

    const after = await readVaultSettings(root)
    expect(after.dailyNotes).toBe(false)
    expect(await settingsAt(root, SETTINGS_FILE)).toMatchObject({
      home: 'board',
      editorFont: 'serif',
      dailyNotes: false,
    })
  })

  it('merges over what is already there, key by key', async () => {
    const root = await vault('{"editorFont":"serif","maxCommittedFileBytes":2048}')
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, SETTINGS_FILE)).toEqual({
      editorFont: 'serif',
      maxCommittedFileBytes: 2048,
      dailyNotes: false,
    })
  })

  it('leaves siblings it knows nothing about alone', async () => {
    // The reminder delivery watermark lives in the local file. A settings write
    // that dropped it would re-fire every reminder the vault has ever fired.
    const root = await vault(undefined, '{"reminders":{"a.md":"2026-08-22T09:00"}}')
    await writeVaultSettings(root, { local: { colorScheme: 'dark' } })
    expect(await settingsAt(root, SETTINGS_LOCAL_FILE)).toEqual({
      reminders: { 'a.md': '2026-08-22T09:00' },
      colorScheme: 'dark',
    })
  })

  it('merges the hooks block per transform', async () => {
    const root = await vault('{"hooks":{"relink":true,"normalize-md":true}}')
    await writeVaultSettings(root, { committed: { hooks: { 'archive-done': true } } })
    expect((await settingsAt(root, SETTINGS_FILE)).hooks).toEqual({
      relink: true,
      'normalize-md': true,
      'archive-done': true,
    })
  })

  it('writes to one file without touching the other', async () => {
    const root = await vault('{"dailyNotes":true}', '{"colorScheme":"light"}')
    await writeVaultSettings(root, { committed: { dailyNotes: false } })
    expect(await settingsAt(root, SETTINGS_FILE)).toEqual({ dailyNotes: false })
    expect(await settingsAt(root, SETTINGS_LOCAL_FILE)).toEqual({ colorScheme: 'light' })
  })

  it('serializes concurrent plugin setting merges', async () => {
    const root = await vault()
    installGoogleForSettingsTest()
    await Promise.all([
      writePluginSettings(root, 'google', { imagesFromAllSenders: true }),
      writePluginSettings(root, 'google', { imageSenders: ['one@example.com'] }),
    ])
    expect((await readVaultSettings(root)).pluginValues.google).toMatchObject({
      imagesFromAllSenders: true,
      imageSenders: ['one@example.com'],
    })
  })

  it('a failed file write does not poison later settings writes', async () => {
    const root = await vault()
    installGoogleForSettingsTest()
    const local = join(root, PLUGINS_LOCAL_FILE)
    await mkdir(local, { recursive: true })
    await expect(
      writePluginSettings(root, 'google', { imagesFromAllSenders: true }),
    ).rejects.toThrow()
    await rm(local, { recursive: true })
    await writePluginSettings(root, 'google', { imagesFromAllSenders: false })
    expect((await readVaultSettings(root)).pluginValues.google?.imagesFromAllSenders).toBe(false)
  })

  it('writes both files in one call', async () => {
    const root = await vault()
    await writeVaultSettings(root, {
      committed: { editorFont: 'serif' },
      local: { colorScheme: 'dark' },
    })
    expect(await settingsAt(root, SETTINGS_FILE)).toEqual({ editorFont: 'serif' })
    expect(await settingsAt(root, SETTINGS_LOCAL_FILE)).toEqual({ colorScheme: 'dark' })
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
    expect(await settingsAt(root, SETTINGS_FILE)).toEqual({ dailyNotes: false })
  })

  it('does nothing at all when given nothing', async () => {
    const root = await vault()
    await writeVaultSettings(root, {})
    await expect(readFile(join(root, SETTINGS_FILE), 'utf8')).rejects.toThrow()
  })

  it('round-trips through the reader', async () => {
    const root = await vault()
    await writeVaultSettings(root, {
      committed: { editorFont: 'mono', dailyNotes: false },
      local: { colorScheme: 'dark' },
    })
    const s = await readVaultSettings(root)
    expect(s.editorFont).toBe('mono')
    expect(s.dailyNotes).toBe(false)
    expect(s.colorScheme).toBe('dark')
    expect(s.warnings).toEqual([])
  })
})

describe('Google image setting persistence through the installed plugin writer', () => {
  it('writes consent only to this vault machine-local settings and reads it back', async () => {
    installGoogleForSettingsTest()
    const root = await vault()
    expect(
      pluginSettingValue(
        (await readVaultSettings(root)).pluginValues,
        GOOGLE_INFO,
        'imagesFromAllSenders',
      ),
    ).toBe(false)

    await writePluginSettings(root, 'google', {
      imagesFromAllSenders: true,
      imageSenders: ['trusted@example.com'],
    })

    const local = parseYaml(await readFile(join(root, PLUGINS_LOCAL_FILE), 'utf8')) as Record<
      string,
      unknown
    >
    expect(local.google).toMatchObject({
      imagesFromAllSenders: true,
      imageSenders: ['trusted@example.com'],
    })
    await expect(readFile(join(root, PLUGINS_FILE), 'utf8')).rejects.toThrow()
    const resolved = await readVaultSettings(root)
    expect(pluginSettingValue(resolved.pluginValues, GOOGLE_INFO, 'imagesFromAllSenders')).toBe(
      true,
    )
    expect(pluginSettingValue(resolved.pluginValues, GOOGLE_INFO, 'imageSenders')).toEqual([
      'trusted@example.com',
    ])
  })
})
