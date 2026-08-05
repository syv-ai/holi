import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fontPathArgs, renderPdf } from '../src/main/pdf/render'
import { resolveTypstBin } from '../src/main/pdf/typst-bin'
// The ACTUAL seeded template — this test proves that exact file compiles.
import plainTemplateTyp from '../src/main/agent/templates/plain/template.typ?raw'

const dirs: string[] = []
async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-render-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('fontPathArgs', () => {
  it('adds --font-path when the sibling _brand/fonts exists', async () => {
    const root = await work()
    const templateDir = join(root, '.holi/document-templates/proposal')
    const fontsDir = join(root, '.holi/document-templates/_brand/fonts')
    await mkdir(fontsDir, { recursive: true })
    expect(fontPathArgs(templateDir)).toEqual(['--font-path', fontsDir])
  })

  it('is empty when there is no _brand/fonts sibling (Plain, un-re-seeded vaults)', async () => {
    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    expect(fontPathArgs(templateDir)).toEqual([])
  })
})

describe('renderPdf (integration — needs typst on PATH; first run fetches cmarker)', () => {
  it('renders a real markdown note through the Plain template to a %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst on this machine — skip, don't fail

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)

    const notePath = join(root, 'report.md')
    await writeFile(
      notePath,
      '---\ntitle: T\n---\n\n## 1. Heading\n\nBody **bold** text and a list:\n\n- a\n- b\n',
    )
    const outPath = join(root, 'out.pdf')

    await renderPdf({ typstBin: typst, templateDir, notePath, outPath, fields: [], meta: {} })

    const bytes = await readFile(outPath)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('renders declared metadata (Date/Recipient) as a header — larger than an empty-meta render', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst on this machine — skip, don't fail

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)

    const notePath = join(root, 'report.md')
    await writeFile(notePath, '---\ntitle: T\n---\n\n## Heading\n\nBody text.\n')

    const fields = [
      { key: 'date', label: 'Date', type: 'date', required: false },
      { key: 'recipient', label: 'Recipient', type: 'text', required: false },
    ] as const
    const emptyOut = join(root, 'empty.pdf')
    const metaOut = join(root, 'meta.pdf')
    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath: emptyOut,
      fields: [...fields],
      meta: {},
    })
    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath: metaOut,
      fields: [...fields],
      meta: { date: '2026-07-26', recipient: 'ACME Corp' },
    })

    const empty = await readFile(emptyOut)
    const withMeta = await readFile(metaOut)
    expect(withMeta.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(withMeta.length).toBeGreaterThan(empty.length)
  }, 30_000)

  it('compiles native number/checkbox/date values through a template', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/t')
    await mkdir(templateDir, { recursive: true })
    await writeFile(
      join(templateDir, 'template.typ'),
      '#let doc(notePath, meta: (:), assets: "") = {\n' +
        '  [Count: #(meta.count + 1)]\n' +
        '  if meta.urgent [ #text(fill: red)[URGENT] ]\n' +
        '  [ On #meta.day.display() ]\n' +
        '}\n',
    )
    const notePath = join(root, 'n.md')
    await writeFile(notePath, '# n\n')
    const outPath = join(root, 'out.pdf')

    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath,
      fields: [
        { key: 'count', label: 'Count', type: 'number', required: false },
        { key: 'urgent', label: 'Urgent', type: 'checkbox', required: false },
        { key: 'day', label: 'Day', type: 'date', required: false },
      ],
      meta: { count: '4', urgent: 'true', day: '2026-07-26' },
    })

    const bytes = await readFile(outPath)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
})

// The seeded source templates, copied into a temp vault so the relative
// `../_brand` imports and the Raleway `--font-path` resolve exactly as in a real
// vault. Proves the branded set compiles end-to-end through renderPdf.
const SRC_TEMPLATES = fileURLToPath(new URL('../src/main/agent/templates', import.meta.url))

describe('renderPdf — branded set (integration — needs typst on PATH)', () => {
  async function vaultWithBrandedSet(): Promise<string> {
    const root = await work()
    const dt = join(root, '.holi/document-templates')
    for (const slug of ['_brand', 'proposal', 'report', 'letter', 'memo', 'contract']) {
      await cp(join(SRC_TEMPLATES, slug), join(dt, slug), { recursive: true })
    }
    return root
  }

  it('renders the proposal (signature + diagram + table tokens) to %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await vaultWithBrandedSet()
    const notePath = join(root, 'tilbud.md')
    await writeFile(
      notePath,
      '---\ntitle: T\n---\n\n# Tilbud til ACME\n\n## Baggrund\n\n' +
        'Se [[projects/q2/plan.md]] og [[plan.md|planen]]. Et **flow**:\n\n' +
        '@@FIG:agent-flow@@\n\n## Pris\n\n| Ydelse | Pris |\n|---|---|\n| Udvikling | 100 |\n\n' +
        '@@SIG:syv.ai ApS|ACME A/S@@\n',
    )
    const outPath = join(root, 'tilbud.pdf')
    await renderPdf({
      typstBin: typst,
      templateDir: join(root, '.holi/document-templates/proposal'),
      notePath,
      outPath,
      fields: [{ key: 'date', label: 'Date', type: 'date', required: false }],
      meta: { date: '2026-07-08' },
    })
    const bytes = await readFile(outPath)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('renders the letter (letterhead + closing) and memo (To/From header) to %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await vaultWithBrandedSet()

    const letterNote = join(root, 'brev.md')
    await writeFile(letterNote, '# Vedr. samarbejde\n\nKære ACME,\n\nTak for mødet.\n')
    const letterOut = join(root, 'brev.pdf')
    await renderPdf({
      typstBin: typst,
      templateDir: join(root, '.holi/document-templates/letter'),
      notePath: letterNote,
      outPath: letterOut,
      fields: [
        { key: 'recipient', label: 'Recipient', type: 'text', required: false },
        { key: 'date', label: 'Date', type: 'date', required: false },
        { key: 'closing', label: 'Closing', type: 'text', required: false },
        { key: 'sender', label: 'Sender', type: 'text', required: false },
      ],
      meta: { recipient: 'ACME A/S', date: '2026-07-08', closing: 'Med venlig hilsen', sender: 'Ada' },
    })
    expect((await readFile(letterOut)).subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const memoNote = join(root, 'memo.md')
    await writeFile(memoNote, '# n\n\nHusk deadline på fredag.\n')
    const memoOut = join(root, 'memo.pdf')
    await renderPdf({
      typstBin: typst,
      templateDir: join(root, '.holi/document-templates/memo'),
      notePath: memoNote,
      outPath: memoOut,
      fields: [
        { key: 'to', label: 'To', type: 'text', required: false },
        { key: 'from', label: 'From', type: 'text', required: false },
        { key: 're', label: 'Re', type: 'text', required: false },
        { key: 'date', label: 'Date', type: 'date', required: false },
      ],
      meta: { to: 'Teamet', from: 'Ada', re: 'Deadline', date: '2026-07-08' },
    })
    expect((await readFile(memoOut)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('renders the contract (numbered clause indentation + signatures) to %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await vaultWithBrandedSet()
    const notePath = join(root, 'aftale.md')
    await writeFile(
      notePath,
      '# Samarbejdsaftale\n\n## Ydelser\n\n5.1 Leverandøren udfører:\n\n- Udvikling\n- Drift\n\n' +
        '5.2 Kunden stiller data til rådighed.\n\n@@SIG:syv.ai ApS|ACME A/S@@\n',
    )
    const outPath = join(root, 'aftale.pdf')
    await renderPdf({
      typstBin: typst,
      templateDir: join(root, '.holi/document-templates/contract'),
      notePath,
      outPath,
      fields: [{ key: 'date', label: 'Date', type: 'date', required: false }],
      meta: { date: '2026-07-08' },
    })
    expect((await readFile(outPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('renders the report (cover + TOC + running header) to %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await vaultWithBrandedSet()
    const notePath = join(root, 'rapport.md')
    await writeFile(notePath, '---\nx: 1\n---\n\n# Rapport\n\n## Indledning\n\nBrødtekst.\n\n## Metode\n\nMere.\n')
    const outPath = join(root, 'rapport.pdf')
    await renderPdf({
      typstBin: typst,
      templateDir: join(root, '.holi/document-templates/report'),
      notePath,
      outPath,
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: false },
        { key: 'subtitle', label: 'Subtitle', type: 'text', required: false },
        { key: 'date', label: 'Date', type: 'date', required: false },
      ],
      meta: { title: 'Rapport', subtitle: 'Et hvidbog', date: '2026-07-08' },
    })
    const bytes = await readFile(outPath)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
})
