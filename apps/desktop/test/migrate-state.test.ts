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
import { STATE_DIR, migrateVaultState } from '../src/main/vault/migrate-state'

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

describe('migrateVaultState', () => {
  it('moves all four, keeping their contents', async () => {
    const root = await vault({
      '.holi/seed-state.local.json': '{"a":1}',
      '.holi/context.local.json': '{"focusedPath":"a.md"}',
      '.holi/hooks.local.log': 'a log line\n',
      '.holi/hook-endpoint.local.txt': '4000\ntok\n',
    })

    const moved = await migrateVaultState(root)

    expect(moved.sort()).toEqual(
      [CONTEXT_FILE, ENDPOINT_FILE, HOOKS_LOG_FILE, SEED_STATE_FILE].sort(),
    )
    expect(await read(root, SEED_STATE_FILE)).toBe('{"a":1}')
    expect(await read(root, HOOKS_LOG_FILE)).toBe('a log line\n')
    expect(await gone(root, '.holi/seed-state.local.json')).toBe(true)
  })

  it('leaves settings, theme, the marker and the icons where they are', async () => {
    // The whole point of the split: these are not machine state. `vault.json`'s
    // path is its meaning, and `icons.json` is edited through the row menu.
    const root = await vault({
      '.holi/settings.json': '{}',
      '.holi/settings.local.json': '{}',
      '.holi/theme.json': '{}',
      '.holi/theme.local.json': '{}',
      '.holi/vault.json': '{"version":1}',
      '.holi/icons.json': '{}',
    })

    await migrateVaultState(root)

    expect((await readdir(join(root, '.holi'))).sort()).toEqual([
      'icons.json',
      'settings.json',
      'settings.local.json',
      'theme.json',
      'theme.local.json',
      'vault.json',
    ])
  })

  it('is a no-op the second time, and reports nothing moved', async () => {
    // It runs on every open, so the steady state has to cost nothing and say so.
    const root = await vault({ '.holi/seed-state.local.json': '{"a":1}' })

    expect(await migrateVaultState(root)).toEqual([SEED_STATE_FILE])
    expect(await migrateVaultState(root)).toEqual([])
    expect(await read(root, SEED_STATE_FILE)).toBe('{"a":1}')
  })

  it('does nothing, and does not throw, for a vault that never had any', async () => {
    const root = await vault()
    await expect(migrateVaultState(root)).resolves.toEqual([])
  })

  it('cannot stop a vault opening, even pointed at nothing', async () => {
    // It runs ahead of the watcher and the sync loop; none of these files is
    // worth refusing to open a vault over.
    await expect(migrateVaultState(join(tmpdir(), 'holi-does-not-exist'))).resolves.toEqual([])
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
