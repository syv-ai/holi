import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseAppManifest } from '@holi/shared'
import { migrateAppManifests } from '../src/main/apps/migrate-manifests'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-migrate-'))
})

async function app(id: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, '.holi/apps', id)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
}

const manifestOf = (id: string) => readFile(join(root, '.holi/apps', id, 'app.yaml'), 'utf8')

describe('migrateAppManifests', () => {
  it('writes a manifest for a slice-1 app that has none', async () => {
    await app('retro-board', { 'index.html': '<h1>hi</h1>' })

    expect(await migrateAppManifests(root)).toEqual(['retro-board'])
    expect(parseAppManifest(await manifestOf('retro-board'))).toEqual({ name: 'retro-board' })
  })

  it('leaves an existing manifest byte-identical and does not claim it migrated', async () => {
    const original = '# hand written\nname: Retro Board\nicon: kanban\n'
    await app('retro-board', { 'index.html': '<h1>hi</h1>', 'app.yaml': original })

    expect(await migrateAppManifests(root)).toEqual([])
    expect(await manifestOf('retro-board')).toBe(original)
  })

  it('skips a directory with no entry document — there is no app to register', async () => {
    await app('scratch', { 'notes.txt': 'wip' })

    expect(await migrateAppManifests(root)).toEqual([])
    await expect(manifestOf('scratch')).rejects.toThrow()
  })

  // Renaming someone's directory is an edit to their vault, not a migration.
  it('skips an invalid id rather than fixing it', async () => {
    await app('My_App', { 'index.html': '<h1>hi</h1>' })

    expect(await migrateAppManifests(root)).toEqual([])
    await expect(manifestOf('My_App')).rejects.toThrow()
  })

  it('only counts an entry document at the app root', async () => {
    await app('retro-board', { 'sub/index.html': '<h1>hi</h1>' })

    expect(await migrateAppManifests(root)).toEqual([])
  })

  it('is idempotent — the second run migrates nothing', async () => {
    await app('retro-board', { 'index.html': '<h1>hi</h1>' })
    await migrateAppManifests(root)
    const written = await manifestOf('retro-board')

    expect(await migrateAppManifests(root)).toEqual([])
    expect(await manifestOf('retro-board')).toBe(written)
  })

  it('migrates several, sorted, and leaves the finished ones alone', async () => {
    await app('zeta', { 'index.html': '' })
    await app('alpha', { 'index.html': '' })
    await app('done', { 'index.html': '', 'app.yaml': 'name: Done\n' })

    expect(await migrateAppManifests(root)).toEqual(['alpha', 'zeta'])
  })

  it('is a no-op in a vault with no apps directory at all', async () => {
    expect(await migrateAppManifests(root)).toEqual([])
  })

  it('ignores a stray file sitting directly in the apps directory', async () => {
    await mkdir(join(root, '.holi/apps'), { recursive: true })
    await writeFile(join(root, '.holi/apps/README.md'), 'not an app')

    expect(await migrateAppManifests(root)).toEqual([])
  })
})
