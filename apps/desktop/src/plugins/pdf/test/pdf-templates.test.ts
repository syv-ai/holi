import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listTemplates, migrateTemplates } from '../main/templates'

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
  const dir = join(root, '.holi/document-templates', slug)
  await mkdir(dir, { recursive: true })
  const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  await writeFile(join(dir, 'template.json'), body)
  await writeFile(join(dir, 'template.typ'), '#let doc(p, meta: (:), assets: "") = []')
}

describe('listTemplates', () => {
  it('returns [] when there is no templates dir', async () => {
    expect(await listTemplates(await vault())).toEqual([])
  })

  it('skips underscore-prefixed dirs even with a valid manifest (_brand foundation)', async () => {
    const root = await vault()
    await seed(root, 'proposal', { name: 'Proposal', fields: [] })
    // _brand carries a manifest-shaped file in no vault, but guard anyway so a
    // future underscore folder can never surface in the picker.
    await seed(root, '_brand', { name: 'Brand', fields: [] })
    const names = (await listTemplates(root)).map((t) => t.slug)
    expect(names).toEqual(['proposal'])
  })

  it('does not expose the exact retired manifest name', async () => {
    const root = await vault()
    await seed(root, 'anything', { name: 'Syv.ai report', fields: [] })
    await seed(root, 'report', { name: 'Report', fields: [] })
    await seed(root, 'custom', { name: 'Custom syv.ai report', fields: [] })
    expect((await listTemplates(root)).map((template) => template.name)).toEqual([
      'Custom syv.ai report',
      'Report',
    ])
  })

  it('reads a template dir + manifest into a Template', async () => {
    const root = await vault()
    await seed(root, 'plain', { name: 'Plain', description: 'Clean.', fields: [] })
    const t = (await listTemplates(root))[0]!
    expect(t).toMatchObject({ name: 'Plain', description: 'Clean.', fields: [], slug: 'plain' })
    expect(t.dir).toBe(join(root, '.holi/document-templates/plain'))
  })

  it('normalizes fields and defaults label/required', async () => {
    const root = await vault()
    await seed(root, 'p', {
      name: 'P',
      fields: [{ key: 'date', label: 'Date', required: true }, { key: 'to' }],
    })
    const t = (await listTemplates(root))[0]!
    expect(t.fields).toEqual([
      { key: 'date', label: 'Date', type: 'text', required: true },
      { key: 'to', label: 'to', type: 'text', required: false },
    ])
  })

  it('parses type, default and options; unknown/missing type falls back to text', async () => {
    const root = await vault()
    await seed(root, 'typed', {
      name: 'Typed',
      fields: [
        { key: 'when', label: 'When', type: 'date', default: 'today' },
        { key: 'status', label: 'Status', type: 'select', options: ['Draft', 'Final'] },
        { key: 'count', label: 'Count', type: 'number' },
        { key: 'weird', label: 'Weird', type: 'nonsense' },
        { key: 'plain', label: 'Plain' },
      ],
    })
    const t = (await listTemplates(root))[0]!
    expect(t.fields).toEqual([
      { key: 'when', label: 'When', type: 'date', required: false, default: 'today' },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        required: false,
        options: ['Draft', 'Final'],
      },
      { key: 'count', label: 'Count', type: 'number', required: false },
      { key: 'weird', label: 'Weird', type: 'text', required: false },
      { key: 'plain', label: 'Plain', type: 'text', required: false },
    ])
  })

  it('a select with no usable options degrades to text', async () => {
    const root = await vault()
    await seed(root, 's', { name: 'S', fields: [{ key: 'x', type: 'select' }] })
    const t = (await listTemplates(root))[0]!
    expect(t.fields).toEqual([{ key: 'x', label: 'x', type: 'text', required: false }])
  })

  it('skips a dir with no manifest and a dir with invalid JSON', async () => {
    const root = await vault()
    await mkdir(join(root, '.holi/document-templates/nomanifest'), { recursive: true })
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

  it('surfaces manifest warnings, still degrading the fields', async () => {
    const root = await vault()
    await seed(root, 'w', {
      name: 'W',
      fields: [
        { key: 'x', type: 'select' },
        { key: 'd', type: 'date', default: '2026-13-40' },
      ],
    })
    const t = (await listTemplates(root))[0]!
    expect(t.warnings.length).toBe(2)
    expect(t.warnings.some((w) => w.includes('select'))).toBe(true)
    expect(t.warnings.some((w) => w.includes('"d"'))).toBe(true)
    expect(t.fields[0]).toMatchObject({ key: 'x', type: 'text' })
    expect(t.fields[1]!.default).toBeUndefined()
  })

  it('reads a language code, and ignores anything else with a warning', async () => {
    const root = await vault()
    await seed(root, 'a', { name: 'A', language: 'EN', fields: [] })
    await seed(root, 'b', { name: 'B', language: 'english', fields: [] })
    const [a, b] = await listTemplates(root)
    expect(a!.language).toBe('en')
    expect(b!.language).toBeUndefined()
    expect(b!.warnings).toEqual([
      '"language" must be a language code such as "da" or "en", and was ignored',
    ])
  })

  it('a clean manifest has no warnings', async () => {
    const root = await vault()
    await seed(root, 'p', { name: 'P', fields: [{ key: 'a', type: 'text' }] })
    const t = (await listTemplates(root))[0]!
    expect(t.warnings).toEqual([])
  })
})

describe('migrateTemplates', () => {
  it('removes modified obsolete contents and restores seeded Report at the report slug', async () => {
    const root = await vault()
    const old = join(root, '.holi/document-templates/report')
    await mkdir(join(old, 'nested'), { recursive: true })
    await writeFile(join(old, 'template.json'), JSON.stringify({ name: 'Syv.ai report' }))
    await writeFile(join(old, 'template.typ'), 'customized')
    await writeFile(join(old, 'nested', 'asset.bin'), Buffer.from([0, 255, 1]))
    const seed = {
      '.holi/document-templates/report/template.json': '{"name":"Report"}',
      '.holi/document-templates/report/template.typ': 'seed report',
    }
    await migrateTemplates(root, seed)
    expect(await readFile(join(old, 'template.typ'), 'utf8')).toBe('seed report')
    expect(await readFile(join(old, 'template.json'), 'utf8')).toBe('{"name":"Report"}')
    expect(await readFile(join(old, 'nested/asset.bin')).catch(() => null)).toBeNull()
    const reportBytes = await readFile(join(old, 'template.typ'))
    await migrateTemplates(root, seed)
    expect(await readFile(join(old, 'template.typ'))).toEqual(reportBytes)
  })

  it('removes obsolete templates at any slug, but preserves unmatched foundation', async () => {
    const root = await vault()
    const legacy = join(root, '.holi/document-templates/_legacy')
    await mkdir(join(legacy, 'nested'), { recursive: true })
    await writeFile(join(legacy, 'template.json'), JSON.stringify({ name: 'Syv.ai report' }))
    await writeFile(join(legacy, 'nested', 'asset.bin'), Buffer.from([0, 255, 12]))
    const foundation = join(root, '.holi/document-templates/_brand')
    await mkdir(foundation, { recursive: true })
    await writeFile(join(foundation, 'brand.typ'), 'foundation')
    await migrateTemplates(root, {})
    expect(await readFile(join(legacy, 'template.json')).catch(() => null)).toBeNull()
    await expect(stat(legacy)).rejects.toThrow()
    expect(await readFile(join(foundation, 'brand.typ'), 'utf8')).toBe('foundation')
  })

  it('removes an obsolete arbitrary slug without changing supported templates', async () => {
    const root = await vault()
    await seed(root, 'legacy', { name: 'Syv.ai report' })
    await writeFile(join(root, '.holi/document-templates/legacy/template.typ'), 'edited')
    await seed(root, 'report', { name: 'Report' })
    await seed(root, 'brand-special', { name: 'Syv.ai proposal' })
    await writeFile(
      join(root, '.holi/document-templates/brand-special/template.typ'),
      Buffer.from([0, 255, 2]),
    )
    const before = await readFile(join(root, '.holi/document-templates/report/template.typ'))
    const branded = await readFile(
      join(root, '.holi/document-templates/brand-special/template.typ'),
    )
    await migrateTemplates(root, {})
    expect(await readFile(join(root, '.holi/document-templates/report/template.typ'))).toEqual(
      before,
    )
    expect(
      await readFile(join(root, '.holi/document-templates/brand-special/template.typ')),
    ).toEqual(branded)
    expect(await listTemplates(root)).toHaveLength(1)
    await migrateTemplates(root, {})
  })

  it('reopens canonical Report restoration from durable state after the obsolete manifest is gone', async () => {
    const root = await vault()
    const base = join(root, '.holi/document-templates/report')
    await mkdir(base, { recursive: true })
    await writeFile(join(base, 'template.json'), JSON.stringify({ name: 'Syv.ai report' }))
    const seed = {
      '.holi/document-templates/report/template.json': '{"name":"Report"}',
      '.holi/document-templates/report/template.typ': 'report',
    }
    await migrateTemplates(root, seed)
    const first = await readFile(join(base, 'template.typ'))
    const before = await stat(join(base, 'template.typ'))
    await migrateTemplates(root, seed)
    expect(await readFile(join(base, 'template.typ'))).toEqual(first)
    expect((await stat(join(base, 'template.typ'))).mtimeMs).toBe(before.mtimeMs)
  })

  it('refuses an unrelated occupant during restoration without overwriting it', async () => {
    const root = await vault()
    const report = join(root, '.holi/document-templates/report')
    await mkdir(report, { recursive: true })
    await writeFile(join(report, 'template.json'), JSON.stringify({ name: 'Syv.ai report' }))
    const seed = {
      '.holi/document-templates/report/template.json': '{"name":"Report"}',
      '.holi/document-templates/report/template.typ': 'seed',
    }
    await migrateTemplates(root, seed)
    await writeFile(join(report, 'template.typ'), 'unrelated')
    await expect(migrateTemplates(root, seed)).rejects.toThrow(/unexpected occupant/)
    expect(await readFile(join(report, 'template.typ'), 'utf8')).toBe('unrelated')
  })

  it('refuses a linked manifest', async () => {
    const root = await vault()
    const outside = join(await vault(), 'manifest.json')
    await writeFile(outside, JSON.stringify({ name: 'Syv.ai report' }))
    const dir = join(root, '.holi/document-templates/report')
    await mkdir(dir, { recursive: true })
    await symlink(outside, join(dir, 'template.json'))
    await expect(migrateTemplates(root, {})).rejects.toThrow(/unsafe template migration path/)
    expect(await readFile(outside, 'utf8')).toContain('Syv.ai report')
  })

  it('refuses a linked child without touching its external target', async () => {
    const root = await vault()
    const outside = join(await vault(), 'sentinel')
    await writeFile(outside, 'safe')
    const dir = join(root, '.holi/document-templates/legacy')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'template.json'), JSON.stringify({ name: 'Syv.ai report' }))
    await symlink(outside, join(dir, 'linked'))
    await migrateTemplates(root, {})
    expect(await readFile(outside, 'utf8')).toBe('safe')
    await expect(stat(join(dir, 'linked'))).rejects.toThrow()
  })

  it('cancellation leaves the obsolete manifest as a retryable identity', async () => {
    const root = await vault()
    const dir = join(root, '.holi/document-templates/report')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'template.json'), JSON.stringify({ name: 'Syv.ai report' }))
    const controller = new AbortController()
    controller.abort()
    await expect(migrateTemplates(root, {}, controller.signal)).rejects.toThrow(/cancelled/)
    expect(await readFile(join(dir, 'template.json'), 'utf8')).toContain('Syv.ai report')
  })
})
