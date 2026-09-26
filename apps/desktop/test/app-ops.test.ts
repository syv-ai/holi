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

async function app(bundle: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, bundle)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content)
}

describe('openAppOp', () => {
  it('opens a finished app anywhere in the vault, answering its bundle', async () => {
    await app('Finance/Budget.app', { 'index.html': '<h1>hi</h1>', 'app.yaml': '' })
    expect(await openAppOp(root, 'Finance/Budget.app')).toEqual({
      ok: true,
      bundle: 'Finance/Budget.app',
    })
  })

  it('tidies a trailing slash and a leading ./', async () => {
    await app('Budget.app', { 'index.html': '<h1>hi</h1>', 'app.yaml': '' })
    expect(await openAppOp(root, './Budget.app/')).toEqual({ ok: true, bundle: 'Budget.app' })
  })

  it('refuses an unfinished bundle, naming app.yaml and how to get one', async () => {
    await app('Retro.app', { 'index.html': '<h1>hi</h1>' })
    const result = await openAppOp(root, 'Retro.app')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/app\.yaml/)
    expect(result.ok === false && result.error).toMatch(/holi app init Retro\.app/)
  })

  it('refuses a manifest with no entry document', async () => {
    await app('Retro.app', { 'app.yaml': '' })
    const result = await openAppOp(root, 'Retro.app')
    expect(result.ok === false && result.error).toMatch(/index\.html/)
  })

  it('refuses an app that does not exist at all', async () => {
    const result = await openAppOp(root, 'Nope.app')
    expect(result.ok === false && result.error).toMatch(/Nope\.app/)
  })

  it('refuses a path that is not a bundle by naming the rule', async () => {
    for (const path of ['retro', '../x.app', '.claude/x.app', 'A.app/B.app']) {
      const result = await openAppOp(root, path)
      expect(result.ok === false && result.error).toMatch(/ends in \.app/)
    }
  })
})

describe('initAppOp', () => {
  it('scaffolds a manifest and an entry document', async () => {
    const result = await initAppOp(root, 'Finance/Budget.app')
    expect(result).toEqual({
      ok: true,
      created: ['Finance/Budget.app/app.yaml', 'Finance/Budget.app/index.html'],
    })
    const manifest = await readFile(join(root, 'Finance/Budget.app/app.yaml'), 'utf8')
    expect(parseAppManifest(manifest)).toEqual({})
    const entry = await readFile(join(root, 'Finance/Budget.app/index.html'), 'utf8')
    expect(entry).toContain('<title>Budget</title>')
  })

  it('the scaffolded app is one openAppOp accepts', async () => {
    await initAppOp(root, 'Retro.app')
    expect((await openAppOp(root, 'Retro.app')).ok).toBe(true)
  })

  it('escapes a name that would be markup', async () => {
    await initAppOp(root, 'a<b>.app')
    expect(await readFile(join(root, 'a<b>.app/index.html'), 'utf8')).toContain('a&lt;b&gt;')
  })

  it('refuses a path that is not a bundle, naming the rule', async () => {
    for (const path of ['Retro', '', 'memory/x.app']) {
      const result = await initAppOp(root, path)
      expect(result.ok === false && result.error).toMatch(/ends in \.app/)
    }
  })

  it('does not clobber an existing manifest', async () => {
    const mine = 'description: mine\n'
    await app('Retro.app', { 'app.yaml': mine, 'index.html': '<h1>mine</h1>' })

    expect(await initAppOp(root, 'Retro.app')).toEqual({ ok: true, created: [] })
    expect(await readFile(join(root, 'Retro.app/app.yaml'), 'utf8')).toBe(mine)
    expect(await readFile(join(root, 'Retro.app/index.html'), 'utf8')).toBe('<h1>mine</h1>')
  })

  it('fills in only the half that is missing', async () => {
    await app('Retro.app', { 'index.html': '<h1>mine</h1>' })
    expect(await initAppOp(root, 'Retro.app')).toEqual({
      ok: true,
      created: ['Retro.app/app.yaml'],
    })
  })
})
