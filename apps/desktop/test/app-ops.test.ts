import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAppManifest } from '@holi/shared'
import { initAppOp, openAppOp, renameAppOp } from '../src/main/apps/app-ops'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-app-ops-'))
  dirs.push(root)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function app(id: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, '.holi/apps', id)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content)
}

describe('openAppOp', () => {
  it('opens a finished app', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    expect(await openAppOp(root, 'retro')).toEqual({ ok: true })
  })

  it('refuses an unregistered directory, naming app.yaml and how to get one', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>' })
    const result = await openAppOp(root, 'retro')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/app\.yaml/)
    expect(result.ok === false && result.error).toMatch(/holi app init/)
  })

  it('refuses a manifest with no entry document', async () => {
    await app('retro', { 'app.yaml': 'name: Retro\n' })
    const result = await openAppOp(root, 'retro')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/index\.html/)
  })

  it('refuses an app that does not exist at all', async () => {
    const result = await openAppOp(root, 'nope')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/nope/)
  })

  it('refuses an invalid id by naming the rule', async () => {
    const result = await openAppOp(root, 'My_App')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/a-z0-9-/)
  })

  it('refuses a traversal rather than reaching outside the apps directory', async () => {
    for (const id of ['../..', 'a/b', '.']) {
      expect((await openAppOp(root, id)).ok).toBe(false)
    }
  })
})

describe('initAppOp', () => {
  it('scaffolds a manifest and an entry document', async () => {
    const result = await initAppOp(root, 'retro')
    expect(result).toEqual({
      ok: true,
      created: ['.holi/apps/retro/app.yaml', '.holi/apps/retro/index.html'],
    })
    const manifest = await readFile(join(root, '.holi/apps/retro/app.yaml'), 'utf8')
    expect(parseAppManifest(manifest)).toEqual({ name: 'retro' })
    const entry = await readFile(join(root, '.holi/apps/retro/index.html'), 'utf8')
    expect(entry).toContain('<!doctype html>')
  })

  it('the scaffolded app is one openAppOp accepts', async () => {
    await initAppOp(root, 'retro')
    expect(await openAppOp(root, 'retro')).toEqual({ ok: true })
  })

  it('refuses an id that is not [a-z0-9-]+, naming the rule', async () => {
    for (const id of ['My_App', 'retro board', 'Retro', '']) {
      const result = await initAppOp(root, id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toMatch(/a-z0-9-/)
    }
  })

  it('does not clobber an existing manifest', async () => {
    const mine = 'name: My Retro\nicon: kanban\n'
    await app('retro', { 'app.yaml': mine, 'index.html': '<h1>mine</h1>' })

    const result = await initAppOp(root, 'retro')
    expect(result).toEqual({ ok: true, created: [] })
    expect(await readFile(join(root, '.holi/apps/retro/app.yaml'), 'utf8')).toBe(mine)
    expect(await readFile(join(root, '.holi/apps/retro/index.html'), 'utf8')).toBe('<h1>mine</h1>')
  })

  it('fills in only the half that is missing', async () => {
    await app('retro', { 'index.html': '<h1>mine</h1>' })
    const result = await initAppOp(root, 'retro')
    expect(result).toEqual({ ok: true, created: ['.holi/apps/retro/app.yaml'] })
    expect(await readFile(join(root, '.holi/apps/retro/index.html'), 'utf8')).toBe('<h1>mine</h1>')
  })
})

describe('renameAppOp', () => {
  it('moves the whole directory, nested files and all', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    await mkdir(join(root, '.holi/apps/retro/lib'), { recursive: true })
    await writeFile(join(root, '.holi/apps/retro/lib/chart.js'), 'export const x = 1\n')

    expect(await renameAppOp(root, 'retro', 'standup')).toEqual({ ok: true, rewritten: [] })

    // A directory rename, not a file-by-file copy: the nested dir survives.
    expect(await readFile(join(root, '.holi/apps/standup/lib/chart.js'), 'utf8')).toBe(
      'export const x = 1\n',
    )
    expect(await readFile(join(root, '.holi/apps/standup/index.html'), 'utf8')).toBe('<h1>hi</h1>')
    expect(await openAppOp(root, 'standup')).toEqual({ ok: true })
    expect((await openAppOp(root, 'retro')).ok).toBe(false)
  })

  it('rewrites every [[link]] that pointed into the old directory', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    await writeFile(
      join(root, 'notes.md'),
      'see [[.holi/apps/retro/index.html]] and [[.holi/apps/retro/app.yaml|the manifest]]\n',
    )

    const result = await renameAppOp(root, 'retro', 'standup')

    expect(result).toEqual({ ok: true, rewritten: [{ path: 'notes.md', count: 2 }] })
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(
      'see [[.holi/apps/standup/index.html]] and [[.holi/apps/standup/app.yaml|the manifest]]\n',
    )
  })

  it('leaves a note that links nowhere near the app untouched', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    await writeFile(join(root, 'notes.md'), 'see [[other.md]]\n')

    expect(await renameAppOp(root, 'retro', 'standup')).toEqual({ ok: true, rewritten: [] })
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('see [[other.md]]\n')
  })

  it('refuses a destination id the rule does not accept', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    for (const id of ['My_App', 'Retro', 'a b', '', 'a/b']) {
      const result = await renameAppOp(root, 'retro', id)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('[a-z0-9-]+')
    }
    // and the source is still where it was
    expect(await openAppOp(root, 'retro')).toEqual({ ok: true })
  })

  it('refuses when the destination is already taken', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    await app('standup', { 'index.html': '<h1>other</h1>' })

    const result = await renameAppOp(root, 'retro', 'standup')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('standup')
    // Neither side moved.
    expect(await readFile(join(root, '.holi/apps/standup/index.html'), 'utf8')).toBe('<h1>other</h1>')
    expect(await openAppOp(root, 'retro')).toEqual({ ok: true })
  })

  it('refuses when there is no such app', async () => {
    const result = await renameAppOp(root, 'nope', 'standup')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('nope')
  })

  it('renaming an app to its own id changes nothing and is not an error', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>', 'app.yaml': 'name: Retro\n' })
    expect(await renameAppOp(root, 'retro', 'retro')).toEqual({ ok: true, rewritten: [] })
    expect(await openAppOp(root, 'retro')).toEqual({ ok: true })
  })

  it('renames an unfinished app too — a manifest is not required to move bytes', async () => {
    await app('retro', { 'index.html': '<h1>hi</h1>' })
    expect(await renameAppOp(root, 'retro', 'standup')).toEqual({ ok: true, rewritten: [] })
    expect(await readFile(join(root, '.holi/apps/standup/index.html'), 'utf8')).toBe('<h1>hi</h1>')
  })
})
