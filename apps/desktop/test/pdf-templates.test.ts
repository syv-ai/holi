import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listTemplates } from '../src/main/pdf/templates'

const dirs: string[] = []
async function vault(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-tpl-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function seed(root: string, slug: string, manifest: unknown): Promise<void> {
  const dir = join(root, '.holi/templates', slug)
  await mkdir(dir, { recursive: true })
  const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  await writeFile(join(dir, 'template.json'), body)
  await writeFile(join(dir, 'template.typ'), '#let doc(p, meta: (:), assets: "") = []')
}

describe('listTemplates', () => {
  it('returns [] when there is no templates dir', async () => {
    expect(await listTemplates(await vault())).toEqual([])
  })

  it('reads a template dir + manifest into a Template', async () => {
    const root = await vault()
    await seed(root, 'plain', { name: 'Plain', description: 'Clean.', fields: [] })
    const [t] = await listTemplates(root)
    expect(t).toMatchObject({ name: 'Plain', description: 'Clean.', fields: [], slug: 'plain' })
    expect(t.dir).toBe(join(root, '.holi/templates/plain'))
  })

  it('normalizes fields and defaults label/required', async () => {
    const root = await vault()
    await seed(root, 'p', {
      name: 'P',
      fields: [{ key: 'date', label: 'Date', required: true }, { key: 'to' }],
    })
    const [t] = await listTemplates(root)
    expect(t.fields).toEqual([
      { key: 'date', label: 'Date', required: true },
      { key: 'to', label: 'to', required: false },
    ])
  })

  it('skips a dir with no manifest and a dir with invalid JSON', async () => {
    const root = await vault()
    await mkdir(join(root, '.holi/templates/nomanifest'), { recursive: true })
    await seed(root, 'broken', '{ not json')
    await seed(root, 'plain', { name: 'Plain', fields: [] })
    expect((await listTemplates(root)).map((t) => t.slug)).toEqual(['plain'])
  })

  it('sorts by display name', async () => {
    const root = await vault()
    await seed(root, 'z', { name: 'Zeta' })
    await seed(root, 'a', { name: 'Alpha' })
    expect((await listTemplates(root)).map((t) => t.name)).toEqual(['Alpha', 'Zeta'])
  })
})
