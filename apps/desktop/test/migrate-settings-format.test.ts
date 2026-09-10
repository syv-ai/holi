/**
 * `.holi/settings/*.json` becoming `*.yaml`, once, per vault.
 *
 * This runs on the way into every vault, so the properties are the migration
 * ones: it converts rather than renames (a file that only changed extension
 * would keep none of the explanations the format change exists for), it never
 * overwrites the newer file, it removes the old one, and it cannot stop a vault
 * opening.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { ICONS_FILE, SETTINGS_FILE, SETTINGS_LOCAL_FILE, THEME_FILE } from '@holi/shared'
import { migrateSettingsFormat } from '../src/main/vault/migrate-settings-format'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function vault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-migrate-format-'))
  roots.push(root)
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) await writeFile(join(root, rel), text, 'utf8')
  return root
}

const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8')
const gone = async (root: string, rel: string) =>
  readFile(join(root, rel), 'utf8').then(
    () => false,
    () => true,
  )

describe('migrateSettingsFormat', () => {
  it('converts rather than renames, so the file gains its explanations', async () => {
    // The whole point. A rename would leave JSON sitting under a `.yaml` name,
    // explaining nothing until somebody happened to touch a control.
    const root = await vault({
      '.holi/settings/app.json': '{"dailyNotes": false, "editorFont": "serif"}',
    })
    await migrateSettingsFormat(root)

    const yaml = await read(root, SETTINGS_FILE)
    expect(parseYaml(yaml)).toEqual({ dailyNotes: false, editorFont: 'serif' })
    expect(yaml).toContain('# Keep a daily note')
    expect(yaml).toContain('# Notes are set in')
    expect(yaml.startsWith('{')).toBe(false)
    expect(await gone(root, '.holi/settings/app.json')).toBe(true)
  })

  it('keeps a sibling key it knows nothing about', async () => {
    // `reminders` is the delivery watermark. Losing it would re-fire every
    // reminder the vault has ever fired.
    const root = await vault({
      '.holi/settings/app.local.json': '{"colorScheme": "dark", "reminders": {"seen": 3}}',
    })
    await migrateSettingsFormat(root)
    expect(parseYaml(await read(root, SETTINGS_LOCAL_FILE))).toEqual({
      colorScheme: 'dark',
      reminders: { seen: 3 },
    })
  })

  it('converts the theme, and names its palettes', async () => {
    const root = await vault({
      '.holi/settings/theme.json': '{"dark": {"primary": "#112233"}, "light": {}}',
    })
    await migrateSettingsFormat(root)
    const yaml = await read(root, THEME_FILE)
    expect(parseYaml(yaml).dark).toEqual({ primary: '#112233' })
    expect(yaml).toContain('# The dark palette.')
  })

  it('converts the icon map without pretending it has anything to explain', async () => {
    const root = await vault({ '.holi/settings/icons.json': '{"a.md": "📌"}' })
    await migrateSettingsFormat(root)
    expect(parseYaml(await read(root, ICONS_FILE))).toEqual({ 'a.md': '📌' })
  })

  it('never overwrites the newer file, and still clears the old one', async () => {
    // The `.yaml` is what the app has been writing since the move; letting an
    // older `.json` win would undo real edits.
    const root = await vault({
      '.holi/settings/app.json': '{"dailyNotes": true}',
      [SETTINGS_FILE]: 'dailyNotes: false\n',
    })
    await migrateSettingsFormat(root)
    expect(parseYaml(await read(root, SETTINGS_FILE))).toEqual({ dailyNotes: false })
    expect(await gone(root, '.holi/settings/app.json')).toBe(true)
  })

  it('is a no-op on a vault that has nothing to convert', async () => {
    const root = await vault()
    expect(await migrateSettingsFormat(root)).toEqual([])
  })

  it('does not throw on a file it cannot parse', async () => {
    // It runs ahead of the watcher and the sync loop; nothing here is worth
    // refusing to open a vault over.
    const root = await vault({ '.holi/settings/app.json': '{ not json at all' })
    await expect(migrateSettingsFormat(root)).resolves.toBeDefined()
  })
})
