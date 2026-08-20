import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAppManifest } from '@holi/shared'
import { initAppOp, openAppOp } from '../src/main/apps/app-ops'

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
