/**
 * The capabilities PDF's renderer calls through the UI door: templates,
 * render and the viewer's signatures.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { PDF_NAMESPACES, pdfCapabilities } from '../main/capabilities'
import { createSignatureStore } from '../main/signatures'
import { resolveTypstBin } from '../main/typst-bin'
import plainTemplateTyp from '../main/vault/once/.holi/document-templates/plain/template.typ?raw'

const TEMPLATE_FILES = {
  '.holi/document-templates/plain/template.json': JSON.stringify({
    name: 'Plain',
    description: 'Clean.',
    fields: [
      { key: 'date', label: 'Date', required: false },
      { key: 'recipient', label: 'Recipient', required: true },
    ],
  }),
  '.holi/document-templates/plain/template.typ': '#let doc(p, meta: (:), assets: "") = []',
}

/** A drawing with every character the comment and the string must survive. */
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><style>.a > text { fill: #333 }</style>' +
  '<rect width="80" height="40" fill="#eef"/><text class="a" x="4" y="24">A --> "B" \\</text></svg>'

let base: string

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** A vault holding `files`, and a runner for PDF's entries at the UI door. */
async function rig(files: Record<string, string> = {}) {
  base = await mkdtemp(join(tmpdir(), 'holi-pdf-caps-'))
  const root = join(base, 'vault')
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  await mkdir(root, { recursive: true })
  const registry = createCapabilityRegistry()
  registry.register(
    PDF_NAMESPACES,
    pdfCapabilities({
      signatures: createSignatureStore(join(base, 'pdf-signatures.json')),
      typst: () => resolveTypstBin(),
      diagrams: async (sources) => sources.map(() => ({ svg: SVG })),
    }),
  )
  const ctx = {
    remote: 'o/r',
    root,
    bundle: null,
    snapshot: async () => emptyVaultSnapshot(),
    core: noCoreServices(),
  }
  const run = async (name: string, params?: unknown) =>
    (await registry.run(name, 'ui', ctx, params)).value
  return { root, run }
}

describe('pdf capabilities', () => {
  it('templates returns each template with its declared fields', async () => {
    const { run } = await rig(TEMPLATE_FILES)
    expect(await run('pdf.templates')).toEqual([
      {
        name: 'Plain',
        slug: 'plain',
        description: 'Clean.',
        fields: [
          { key: 'date', label: 'Date', type: 'text', required: false },
          { key: 'recipient', label: 'Recipient', type: 'text', required: true },
        ],
        warnings: [],
      },
    ])
  })

  it('keeps the signatures made in the viewer, outside the vault', async () => {
    const { root, run } = await rig()
    expect(await run('pdf.signatures')).toBe('[]')

    const entries = [{ id: 'sig-1', createdAt: 1, signature: { creationType: 'draw' } }]
    await run('pdf.saveSignatures', { entriesJson: JSON.stringify(entries) })

    expect(JSON.parse((await run('pdf.signatures')) as string)).toEqual(entries)
    // Never in the clone: a vault is a shared repo.
    await expect(readFile(join(root, 'pdf-signatures.json'), 'utf8')).rejects.toThrow()
  })

  it('saveSignatures refuses anything but a list', async () => {
    const { run } = await rig()
    await expect(run('pdf.saveSignatures', { entriesJson: '{}' })).rejects.toThrow(/list/)
  })

  it('render rejects a meta value that is not a string', async () => {
    const { run } = await rig({ ...TEMPLATE_FILES, 'note.md': '# Hi\n' })
    await expect(
      run('pdf.render', { path: 'note.md', template: 'plain', meta: { date: 5 } }),
    ).rejects.toThrow(/meta/)
  })

  it('render writes to the given out, fills fields and threads meta through (needs typst)', async () => {
    if ((await resolveTypstBin()) === null) return // no typst: skip, don't fail
    const { run } = await rig({
      '.holi/document-templates/plain/template.json': JSON.stringify({
        name: 'Plain',
        fields: [
          { key: 'date', label: 'Date', type: 'date', required: false },
          { key: 'recipient', label: 'Recipient', required: true },
        ],
      }),
      '.holi/document-templates/plain/template.typ': plainTemplateTyp,
      'note.md':
        '---\nrecipient: ACME\n---\n\n## Heading\n\n```mermaid\nflowchart LR\n  A --> B\n```\n',
    })
    const out = join(base, 'chosen.pdf')
    const result = await run('pdf.render', { path: 'note.md', out, meta: { date: '2026-07-26' } })
    expect(result).toEqual({
      pdfPath: out,
      vaultPath: null,
      bytes: expect.any(Number),
      warnings: [],
    })
    const bytes = await readFile(out)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('render refuses a field the template does not have, and a missing required one', async () => {
    const { run } = await rig({ ...TEMPLATE_FILES, 'note.md': '# Hi\n' })
    await expect(
      run('pdf.render', { path: 'note.md', meta: { recipient: 'A', colour: 'red' } }),
    ).rejects.toThrow(/colour/)
    await expect(run('pdf.render', { path: 'note.md' })).rejects.toThrow(/recipient/)
  })

  it('render will not read a note through a symlink that leaves the vault', async () => {
    const { root, run } = await rig({ ...TEMPLATE_FILES })
    await writeFile(join(base, 'secret.md'), '# Secret\n')
    await symlink(join(base, 'secret.md'), join(root, 'note.md'))
    await expect(run('pdf.render', { path: 'note.md', meta: { recipient: 'A' } })).rejects.toThrow(
      /escapes vault/,
    )
  })

  it('render will not write through a symlink, or to a relative out outside the vault', async () => {
    const { root, run } = await rig({ ...TEMPLATE_FILES, 'note.md': '# Hi\n', 'other.pdf': '' })
    await symlink(join(root, 'other.pdf'), join(root, 'note.pdf'))
    await expect(run('pdf.render', { path: 'note.md', meta: { recipient: 'A' } })).rejects.toThrow(
      /symlink/,
    )
    await mkdir(join(base, 'outside'))
    await symlink(join(base, 'outside'), join(root, 'out'))
    await expect(
      run('pdf.render', { path: 'note.md', out: 'out/x.pdf', meta: { recipient: 'A' } }),
    ).rejects.toThrow(/escapes vault/)
    await expect(
      run('pdf.render', { path: 'note.md', out: '../x.pdf', meta: { recipient: 'A' } }),
    ).rejects.toThrow()
  })

  it('render will not read a secret or machine-state note, nor write a PDF into one', async () => {
    const { root, run } = await rig({
      ...TEMPLATE_FILES,
      'note.md': '# Hi\n',
      '.secrets/x.md': '# Secret\n',
      '.holi/state/x.md': '# State\n',
    })
    const meta = { recipient: 'A' }
    for (const path of ['.secrets/x.md', '.holi/state/x.md']) {
      await expect(run('pdf.render', { path, out: 'notes/x.pdf', meta })).rejects.toThrow(
        /secret or machine-state/,
      )
    }
    await symlink(join(root, '.secrets/x.md'), join(root, 'alias.md'))
    await expect(run('pdf.render', { path: 'alias.md', meta })).rejects.toThrow(
      /secret or machine-state/,
    )
    for (const out of ['.env/x.pdf', '.holi/state/x.pdf', join(root, '.holi/state/x.pdf')]) {
      await expect(run('pdf.render', { path: 'note.md', out, meta })).rejects.toThrow(
        /secret or machine-state/,
      )
    }
  })
})
