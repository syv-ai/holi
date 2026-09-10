/**
 * Machine state moving into `.holi/state/` (#16).
 *
 * The migration runs on the way into every vault, ahead of the watcher and the
 * sync loop, so the properties that matter are: it moves what it should, it
 * leaves the settings and the marker alone, and it cannot stop a vault opening.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SEED_STATE_FILE } from '../src/main/agent/seed-state'
import { CONTEXT_FILE } from '../src/main/agent/context-snapshot'
import { HOOKS_LOG_FILE } from '../src/main/vault/hooks/log'
import { ENDPOINT_FILE } from '../src/main/vault/large-files'
import { VAULT_MARKER_FILE } from '@holi/shared'

/**
 * The layout migration's targets, spelled out rather than imported.
 *
 * `SETTINGS_FILE` and friends are `.yaml` now, and this module still moves
 * things to `.json` on purpose: `migrateSettingsFormat` converts them straight
 * afterwards, so a vault three layouts behind is fixed in one pass by two steps
 * that know nothing about each other. Importing the constants here would make
 * this file assert the other migration's job and fail for the wrong reason.
 */
const SETTINGS_FILE = '.holi/settings/app.json'
const THEME_FILE = '.holi/settings/theme.json'
const ICONS_FILE = '.holi/settings/icons.json'
import { STATE_DIR, migrateVaultLayout } from '../src/main/vault/migrate-layout'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function vault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-migrate-state-'))
  roots.push(root)
  await mkdir(join(root, '.holi'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) await writeFile(join(root, rel), text, 'utf8')
  return root
}

const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8')
const gone = async (root: string, rel: string) =>
  readFile(join(root, rel), 'utf8').then(
    () => false,
    () => true,
  )

describe('migrateVaultLayout', () => {
  it('moves all four, keeping their contents', async () => {
    const root = await vault({
      '.holi/seed-state.local.json': '{"a":1}',
      '.holi/context.local.json': '{"focusedPath":"a.md"}',
      '.holi/hooks.local.log': 'a log line\n',
      '.holi/hook-endpoint.local.txt': '4000\ntok\n',
    })

    const moved = await migrateVaultLayout(root)

    expect(moved.sort()).toEqual(
      [CONTEXT_FILE, ENDPOINT_FILE, HOOKS_LOG_FILE, SEED_STATE_FILE].sort(),
    )
    expect(await read(root, SEED_STATE_FILE)).toBe('{"a":1}')
    expect(await read(root, HOOKS_LOG_FILE)).toBe('a log line\n')
    expect(await gone(root, '.holi/seed-state.local.json')).toBe(true)
  })

  it('leaves .holi with two directories and one flag', async () => {
    // The shape this exists to produce. Everything a person chooses in
    // `settings/`, everything nobody opens in `state/`, and the marker on top.
    const root = await vault({
      '.holi/settings.json': '{"dailyNotes":true}',
      '.holi/settings.local.json': '{}',
      '.holi/theme.json': '{}',
      '.holi/theme.local.json': '{}',
      '.holi/icons.json': '{"a.md":"🎯"}',
      '.holi/icons.local.json': '{}',
      '.holi/vault.json': '{"version":1}',
      '.holi/context.local.json': '{}',
    })

    await migrateVaultLayout(root)

    expect((await readdir(join(root, '.holi'))).sort()).toEqual(['settings', 'state', 'vault'])
    expect((await readdir(join(root, '.holi/settings'))).sort()).toEqual([
      'app.json',
      'app.local.json',
      'icons.json',
      'icons.local.json',
      'theme.json',
      'theme.local.json',
    ])
  })

  it('renames settings.json to app.json, contents intact', async () => {
    // `settings/settings.json` was the one path in this layout that read badly.
    const root = await vault({ '.holi/settings.json': '{"dailyNotes":false}' })

    await migrateVaultLayout(root)

    expect(await read(root, SETTINGS_FILE)).toBe('{"dailyNotes":false}')
    expect(SETTINGS_FILE).toBe('.holi/settings/app.json')
  })

  it('turns the marker into an extensionless flag', async () => {
    // Nothing ever parsed the JSON — `isVaultClone` asks only whether the file
    // reads — so the extension was promising a document that never existed.
    const root = await vault({ '.holi/vault.json': '{"version":1}' })

    await migrateVaultLayout(root)

    expect(VAULT_MARKER_FILE).toBe('.holi/vault')
    expect(await gone(root, '.holi/vault.json')).toBe(true)
    // The move keeps whatever was inside; the seed writes `1` from now on.
    expect(await read(root, VAULT_MARKER_FILE)).toBe('{"version":1}')
  })

  it('keeps icons a separate file rather than folding it into the theme', async () => {
    // They share a layering pattern and nothing else: a theme is a CLOSED
    // whitelist validated as CSS, an icon map is unbounded and path-keyed.
    const root = await vault({ '.holi/icons.json': '{"a.md":"🎯"}', '.holi/theme.json': '{}' })

    await migrateVaultLayout(root)

    expect(await read(root, ICONS_FILE)).toBe('{"a.md":"🎯"}')
    expect(await read(root, THEME_FILE)).toBe('{}')
  })

  it('is a no-op the second time, and reports nothing moved', async () => {
    // It runs on every open, so the steady state has to cost nothing and say so.
    const root = await vault({ '.holi/seed-state.local.json': '{"a":1}' })

    expect(await migrateVaultLayout(root)).toEqual([SEED_STATE_FILE])
    expect(await migrateVaultLayout(root)).toEqual([])
    expect(await read(root, SEED_STATE_FILE)).toBe('{"a":1}')
  })

  it('does nothing, and does not throw, for a vault that never had any', async () => {
    const root = await vault()
    await expect(migrateVaultLayout(root)).resolves.toEqual([])
  })

  it('cannot stop a vault opening, even pointed at nothing', async () => {
    // It runs ahead of the watcher and the sync loop; none of these files is
    // worth refusing to open a vault over.
    await expect(migrateVaultLayout(join(tmpdir(), 'holi-does-not-exist'))).resolves.toEqual([])
  })

  it('keeps the .local. marker, or git would start committing them', async () => {
    // D65: local-ness is that marker and nothing else, and the seeded
    // `.gitignore` carries exactly `*.local.*`. A rename to a bare name under a
    // directory that merely sounds private is a published private file.
    for (const rel of [SEED_STATE_FILE, CONTEXT_FILE, HOOKS_LOG_FILE, ENDPOINT_FILE]) {
      expect(rel.startsWith(`${STATE_DIR}/`)).toBe(true)
      expect(rel.split('/').at(-1)).toMatch(/\.local\./)
    }
  })
})
