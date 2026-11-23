import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import { writeMarkdownCaptionEnvelope } from '@holi/shared'
import { fontPathArgs, renderPdf } from '../main/render'
import { commentSafeString } from '../main/mermaid'
import { resolveTypstBin } from '../main/typst-bin'
// The ACTUAL seeded template — this test proves that exact file compiles.
import plainTemplateTyp from '../main/vault/once/.holi/document-templates/plain/template.typ?raw'

/** A 1×1 PNG. */
const DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const dirs: string[] = []
async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-render-'))
  dirs.push(d)
  return d
}

async function readPdfPages(path: string) {
  const require = createRequire(__filename)
  const wasmPath = require.resolve('@embedpdf/pdfium/pdfium.wasm')
  const wasm = await readFile(wasmPath)
  const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)
  const module = await init({ wasmBinary })
  module.PDFiumExt_Init()
  const pdfium = new PdfiumNative(module)
  const content = await readFile(path)
  const bytes = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)
  const document = await pdfium
    .openDocumentBuffer({ id: 'table-caption-test', content: bytes })
    .toPromise()
  try {
    return await Promise.all(
      document.pages.map(async (page) => ({
        width: page.size.width,
        runs: (await pdfium.getPageTextRuns(document, page).toPromise()).runs,
      })),
    )
  } finally {
    await pdfium.closeDocument(document).toPromise()
  }
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

describe('renderPdf preprocessing', () => {
  it('keeps captions attached to their source frames across removed envelopes', async () => {
    const root = await work()
    const templateDir = join(root, 'template')
    await mkdir(templateDir)
    await writeFile(join(templateDir, 'template.typ'), '')
    const typstBin = join(root, 'capture-typst')
    await writeFile(
      typstBin,
      '#!/usr/bin/env node\nconst fs = require("node:fs"); const path = require("node:path"); fs.copyFileSync(path.join(path.dirname(process.argv[3]), "note.md"), process.argv[4]);\n',
    )
    await chmod(typstBin, 0o755)
    const notePath = join(root, 'note.md')
    const missing = writeMarkdownCaptionEnvelope('![](missing.png)', 'missing caption')
    const first = writeMarkdownCaptionEnvelope('```js\nconst a = 1\n```', 'caption A')
    const second = writeMarkdownCaptionEnvelope('```js\nconst b = 2\n```', 'caption B')
    const original = `${missing}\n\n${first}\n\n${second}\n\n
tail\n\n
after diagram`
    await writeFile(notePath, original)
    const outPath = join(root, 'captured.md')
    const result = await renderPdf({
      typstBin,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
      diagrams: async (sources) => {
        expect(sources).toEqual([])
        return []
      },
    })
    const transformed = await readFile(outPath, 'utf8')
    expect(transformed.match(/caption A/g)).toHaveLength(1)
    expect(transformed.match(/caption B/g)).toHaveLength(1)
    expect(transformed.indexOf('const a = 1')).toBeLessThan(transformed.indexOf('caption A'))
    expect(transformed.indexOf('const b = 2')).toBeLessThan(transformed.indexOf('caption B'))
    expect(transformed).toContain('missing caption')
    expect(result.warnings).toEqual([
      'The image on line 3 is left out: missing.png: no such file in the vault',
    ])
    expect(await readFile(notePath, 'utf8')).toBe(original)
  })
  it.each(['nested', 'fenced-before', 'fenced-after', 'indented-before', 'indented-after'])(
    'leaves unsupported table envelopes byte-for-byte and converts later captions: %s',
    async (kind) => {
      const root = await work()
      const templateDir = join(root, 'template')
      await mkdir(templateDir)
      await writeFile(join(templateDir, 'template.typ'), '')
      const typstBin = join(root, 'capture-typst')
      await writeFile(
        typstBin,
        '#!/usr/bin/env node\nconst fs = require("node:fs"); const path = require("node:path"); fs.copyFileSync(path.join(path.dirname(process.argv[3]), "note.md"), process.argv[4]);\n',
      )
      await chmod(typstBin, 0o755)
      const nestedInner = writeMarkdownCaptionEnvelope(
        '| Inner |\n| --- |\n| value |',
        'Inner caption',
      )
      const nested = `<!-- holi:figure -->\n\nouter body\n\n${nestedInner}\n\n<!-- holi:caption -->\n\nouter caption\n\n<!-- /holi:figure -->`
      const table = '| A |\n| --- |\n| value |'
      const extra = kind.startsWith('fenced') ? '```txt\nkeep code\n```' : '    keep code'
      const unsupported =
        kind === 'nested'
          ? nested
          : writeMarkdownCaptionEnvelope(
              kind.endsWith('before') ? `${extra}\n\n${table}` : `${table}\n\n${extra}`,
              'Unsupported caption',
            )
      const later = writeMarkdownCaptionEnvelope('| Later |\n| --- |\n| value |', 'Later caption')
      const notePath = join(root, 'nested.md')
      await writeFile(notePath, `${unsupported}\n\n${later}`)
      const outPath = join(root, 'captured.md')
      await renderPdf({
        typstBin,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
        diagrams: async () => [],
      })
      const transformed = await readFile(outPath, 'utf8')
      expect(transformed.slice(0, unsupported.length)).toBe(unsupported)
      expect(transformed).toContain('Later caption')
      expect(transformed.match(/Later caption/g)).toHaveLength(1)
      expect(transformed.slice(unsupported.length)).not.toContain('<!-- holi:figure -->')
      expect(transformed.slice(unsupported.length)).toContain('<!--raw-typst ')
      expect(await readFile(notePath, 'utf8')).toBe(`${unsupported}\n\n${later}`)
    },
  )

  it('keeps mixed table, image, code, and Mermaid captions in source order', async () => {
    const root = await work()
    const templateDir = join(root, 'template')
    await mkdir(templateDir)
    await writeFile(join(templateDir, 'template.typ'), '')
    const typstBin = join(root, 'capture-typst')
    await writeFile(
      typstBin,
      '#!/usr/bin/env node\nconst fs = require("node:fs"); const path = require("node:path"); fs.copyFileSync(path.join(path.dirname(process.argv[3]), "note.md"), process.argv[4]);\n',
    )
    await chmod(typstBin, 0o755)
    const original = [
      writeMarkdownCaptionEnvelope('| Item |\n| --- |\n| table |', 'Table caption'),
      writeMarkdownCaptionEnvelope('![](missing.png)', 'Image caption'),
      writeMarkdownCaptionEnvelope('```js\nconst code = 1\n```', 'Code caption'),
      writeMarkdownCaptionEnvelope('```mermaid\nflowchart LR\n A --> B\n```', 'Mermaid caption'),
    ].join('\n\n')
    const notePath = join(root, 'mixed.md')
    await writeFile(notePath, original)
    const outPath = join(root, 'captured.md')
    const result = await renderPdf({
      typstBin,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
      diagrams: async () => [
        { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>' },
      ],
    })
    const transformed = await readFile(outPath, 'utf8')
    const captions = ['Table caption', 'Image caption', 'Code caption', 'Mermaid caption']
    const positions = captions.map((caption) => transformed.indexOf(caption))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(transformed).toContain('const code = 1')
    expect(transformed).toContain('diagram')
    expect(transformed).not.toMatch(/<!--\s*holi-pdf-[a-z0-9]+-(?:image-)?\d+\s*-->/)
    expect(result.warnings).toEqual([
      'The image on line 15 is left out: missing.png: no such file in the vault',
    ])
    expect(await readFile(notePath, 'utf8')).toBe(original)
  })

  it.each([false, true])(
    'preserves literal SVG wiki-link labels (caption present: %s)',
    async (captioned) => {
      const root = await work()
      const templateDir = join(root, 'template')
      await mkdir(templateDir)
      await writeFile(join(templateDir, 'template.typ'), '')
      const typstBin = join(root, 'capture-typst')
      await writeFile(
        typstBin,
        '#!/usr/bin/env node\nconst fs = require("node:fs"); const path = require("node:path"); fs.copyFileSync(path.join(path.dirname(process.argv[3]), "note.md"), process.argv[4]);\n',
      )
      await chmod(typstBin, 0o755)
      const notePath = join(root, 'note.md')
      const prefix = captioned
        ? writeMarkdownCaptionEnvelope('```js\nx\n```', 'Caption') + '\n\n'
        : ''
      await writeFile(
        notePath,
        prefix + 'Prose [[note.md|readable]].\n\n```mermaid\nflowchart LR\n A --> B\n```',
      )
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>[[literal|display]]</text></svg>'
      const outPath = join(root, 'captured.md')
      await renderPdf({
        typstBin,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
        diagrams: async () => [{ svg }],
      })
      const transformed = await readFile(outPath, 'utf8')
      expect(transformed).toContain(commentSafeString(svg))
      expect(transformed).toContain('Prose readable.')
    },
  )
})

const describeTypst = describe.skipIf((await resolveTypstBin()) === null)

describeTypst('renderPdf (integration — needs typst; first run fetches cmarker)', () => {
  it('keeps table reference URIs contextual, ordered, and identical to ordinary Markdown', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return
    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)

    const table = (link: string) =>
      writeMarkdownCaptionEnvelope(`| A |\n| --- |\n| ${link} |`, 'Edge caption.')
    const scenarios = [
      {
        name: 'escaped-code',
        source: `${table('[code]')}\n\n\`\`\`markdown\n[code]: <https://example.com/hidden\\>a>\n\`\`\`\n`,
        uris: [],
      },
      {
        name: 'duplicate-order',
        source: `${String.raw`[ref]: <https://example.com/first\>a>`}\n\n${table('[ref]')}\n\n[ref]: https://example.com/second\n`,
        uris: ['https://example.com/first>a'],
      },
      {
        name: 'reverse-duplicate-order',
        source: `[ref]: https://example.com/second\n\n${table('[ref]')}\n\n[ref]: <https://example.com/first\\>a>\n`,
        uris: ['https://example.com/second'],
      },
      {
        name: 'html-definition',
        source: `${table('[html]')}\n\n<div>\n[html]: <https://example.com/html\\>a>\n</div>\n`,
        uris: [],
      },
      {
        name: 'html-comment-definition',
        source: `${table('[comment]')}\n\n<!--\n[comment]: <https://example.com/comment\\>a>\n-->\n`,
        uris: [],
      },
      {
        name: 'indented-code-definition',
        source: `${table('[code]')}\n\n    [code]: <https://example.com/code\\>a>\n`,
        uris: [],
      },
      {
        name: 'quoted-definition',
        source: `${table('[ref]')}\n\n> [ref]: <https://example.com/quoted\\>a>\n`,
        uris: ['https://example.com/quoted>a'],
      },
      {
        name: 'list-definition',
        source: `${table('[ref]')}\n\n- [ref]: <https://example.com/list\\>a>\n`,
        uris: ['https://example.com/list>a'],
      },
      {
        name: 'paired-backslashes',
        source: `${table('[ref]')}\n\n${String.raw`[ref]: <https://example.com/a\\>b>`}\n`,
      },
      {
        name: 'ordinary-paired-backslashes',
        source: `| A |\n| --- |\n| [ref] |\n\n${String.raw`[ref]: <https://example.com/a\\>b>`}\n`,
      },
      {
        name: 'ordinary-table-parity',
        source: `| A |\n| --- |\n| [ref] |\n\n[ref]: <https://example.com/quoted\\>a>\n`,
        uris: ['https://example.com/quoted>a'],
      },
    ]

    const pairedResults: string[] = []
    for (const scenario of scenarios) {
      const notePath = join(root, `${scenario.name}.md`)
      const outPath = join(root, `${scenario.name}.pdf`)
      await writeFile(notePath, scenario.source)
      await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
      })
      expect(await readFile(notePath, 'utf8'), scenario.name).toBe(scenario.source)
      const pdf = (await readFile(outPath)).toString('latin1')
      const uris = [...pdf.matchAll(/\/URI\s*\((.*?)\)/g)].map((match) => match[1])
      if (!scenario.name.includes('paired-backslashes')) {
        expect(uris, scenario.name).toEqual(scenario.uris)
      }
      const pages = await readPdfPages(outPath)
      const text = pages.flatMap((page) => page.runs.map((run) => run.text)).join(' ')
      if (scenario.name.includes('paired-backslashes')) {
        pairedResults.push(
          JSON.stringify({
            uris,
            text: text
              .replace(/Edge\s+caption\./g, '')
              .replace(/\s+/g, ' ')
              .trim(),
          }),
        )
      }
      if (!scenario.name.startsWith('ordinary-')) {
        expect(text.replace(/\s+/g, ' ').match(/Edge caption\./g), scenario.name).toHaveLength(1)
      }
    }
    expect(pairedResults).toHaveLength(2)
    expect(pairedResults[0]).toBe(pairedResults[1])
  })

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

    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })

    const bytes = await readFile(outPath)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('renders a breakable native GFM table with one attached caption', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'table.md')
    const rows = Array.from(
      { length: 400 },
      (_, index) =>
        `| Row ${String(index + 1).padStart(3, '0')} | ${index === 0 ? '`@@FIG:fake@@ --> #panic("literal")`' : `Value ${index + 1}`} |`,
    ).join('\n')
    const original = writeMarkdownCaptionEnvelope(
      `| Name | Value |\n|:---|---:|\n${rows}`,
      '**Table caption** with `code` &amp; _formatting_.',
    )
    await writeFile(notePath, original)
    const outPath = join(root, 'table.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    expect((await readFile(outPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await readFile(notePath, 'utf8')).toBe(original)
    const pages = await readPdfPages(outPath)
    expect(pages.length).toBeGreaterThan(1)
    const pageText = pages.map(({ runs }) => runs.map((run) => run.text).join(''))
    const allText = pageText.join('\\n')
    for (let row = 1; row <= 400; row++) {
      expect(allText).toContain(`Row ${String(row).padStart(3, '0')}`)
    }
    expect(pageText.filter((text) => text.includes('Name')).length).toBeGreaterThan(1)
    for (const text of pageText.filter((value) => value.includes('Name'))) {
      expect(text).toMatch(/Row \d{3}/)
    }
    expect(allText.match(/Table caption/g)).toHaveLength(1)
    const finalPage = pages.find(({ runs }) => runs.some((run) => run.text.includes('Row 400')))
    const captionPage = pages.find(({ runs }) =>
      runs.some((run) => run.text.includes('Table caption')),
    )
    expect(captionPage).toBe(finalPage)
    const captionRun = captionPage?.runs.find((run) => run.text.includes('Table caption'))
    const finalRowRun = finalPage?.runs.find((run) => run.text.includes('Value 400'))
    expect(captionRun).toBeDefined()
    expect(finalRowRun).toBeDefined()
    const headerName = pages[0]!.runs.find((run) => run.text.includes('Name'))
    const headerValue = pages[0]!.runs.find((run) => run.text.includes('Value'))
    expect(headerName).toBeDefined()
    expect(headerValue).toBeDefined()
    const tableCenter =
      (headerName!.rect.origin.x + headerValue!.rect.origin.x + headerValue!.rect.size.width) / 2
    expect(
      Math.abs(captionRun!.rect.origin.x + captionRun!.rect.size.width / 2 - tableCenter),
    ).toBeLessThan(70)
    expect(captionRun!.rect.origin.y).toBeGreaterThan(finalRowRun!.rect.origin.y)
    if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
      await cp(outPath, join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'table-pagination.pdf'))
      const previewNote = join(root, 'caption-preview.md')
      const previewPdf = join(root, 'caption-preview.pdf')
      await writeFile(
        previewNote,
        writeMarkdownCaptionEnvelope(
          '| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
          'Centered table caption.',
        ),
      )
      await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath: previewNote,
        outPath: previewPdf,
        fields: [],
        meta: {},
      })
      await cp(previewPdf, join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'table-caption.pdf'))
    }
  }, 30_000)

  it.each([
    {
      name: 'frontmatter does not shadow a body definition',
      prefix: '---\ndescription: |\n  [ref]: https://wrong.example/\n---\n\n',
      cell: '[ref]',
      definition: '[ref]: https://right.example/',
      destination: 'https://right.example/',
      visible: 'ref',
    },
    {
      name: 'non-breaking space in a reference label is preserved',
      prefix: '',
      cell: '[a\u00a0b]',
      definition: '[a\u00a0b]: https://example.com/unicode',
      destination: 'https://example.com/unicode',
      visible: 'a\u00a0b',
    },
    {
      name: 'escaped angle bracket in a destination resolves',
      prefix: '',
      cell: '[ref]',
      definition: String.raw`[ref]: <https://example.com/a\>b>`,
      destination: 'https://example.com/a>b',
      visible: 'ref',
    },
    {
      name: 'escaped angle definitions in fenced code stay inactive',
      prefix: '',
      cell: '[hidden]',
      definition: '```markdown\n' + String.raw`[hidden]: <https://example.org/a\>b>` + '\n```',
      destination: null,
      visible: '[hidden]',
    },
    {
      name: 'escaped angle definitions in HTML stay inactive',
      prefix: '',
      cell: '[hidden]',
      definition: '<div>\n' + String.raw`[hidden]: <https://example.org/a\>b>` + '\n</div>',
      destination: null,
      visible: '[hidden]',
    },
    {
      name: 'first escaped angle definition keeps duplicate precedence',
      prefix: '',
      cell: '[ref]',
      definition:
        String.raw`[ref]: <https://example.org/first\>path>` +
        '\n[ref]: https://example.org/second',
      destination: 'https://example.org/first>path',
      visible: 'ref',
    },
  ])(
    'keeps native captioned-table reference behavior: $name',
    async (fixture) => {
      const typst = await resolveTypstBin()
      if (typst === null) throw new Error('Typst is required for real PDF compilation')

      const root = await work()
      const templateDir = join(root, '.holi/document-templates/plain')
      await mkdir(templateDir, { recursive: true })
      await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
      const table = `| Link | Row marker |\n| --- | --- |\n| ${fixture.cell} | Differential table row |`
      const references = `${fixture.definition}\n`
      const ordinaryOriginal = `${fixture.prefix}${table}\n\n${references}`
      const captionedOriginal =
        `${fixture.prefix}` +
        `${writeMarkdownCaptionEnvelope(table, 'Differential table caption.')}\n\n${references}`
      const ordinaryNote = join(root, 'ordinary.md')
      const captionedNote = join(root, 'captioned.md')
      await writeFile(ordinaryNote, ordinaryOriginal)
      await writeFile(captionedNote, captionedOriginal)
      const ordinaryPdf = join(root, 'ordinary.pdf')
      const captionedPdf = join(root, 'captioned.pdf')
      for (const [notePath, outPath] of [
        [ordinaryNote, ordinaryPdf],
        [captionedNote, captionedPdf],
      ] as const) {
        await renderPdf({
          typstBin: typst,
          vaultRoot: root,
          templateDir,
          notePath,
          outPath,
          fields: [],
          meta: {},
        })
        expect((await readFile(outPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      }

      const destinations = async (path: string) =>
        (await readFile(path))
          .toString('latin1')
          .split('/URI (')
          .slice(1)
          .map((entry) => entry.split(')')[0]!)
      const ordinaryDestinations = await destinations(ordinaryPdf)
      const captionedDestinations = await destinations(captionedPdf)
      if (fixture.destination !== null) expect(ordinaryDestinations).toContain(fixture.destination)
      expect(captionedDestinations).toEqual(ordinaryDestinations)

      const pages = await readPdfPages(captionedPdf)
      const runs = pages.flatMap((page, pageIndex) =>
        page.runs.map((run) => ({ ...run, pageIndex })),
      )
      const text = runs.map((run) => run.text).join(' ')
      expect(text).toContain(fixture.visible)
      expect(text.split('Differential table caption.')).toHaveLength(2)
      const row = runs.find((run) => run.text.includes('Differential table row'))
      const caption = runs.find((run) => run.text.includes('Differential table caption.'))
      expect(row).toBeDefined()
      expect(caption).toBeDefined()
      expect(
        caption!.pageIndex > row!.pageIndex || caption!.rect.origin.y > row!.rect.origin.y,
      ).toBe(true)
      expect(await readFile(ordinaryNote, 'utf8')).toBe(ordinaryOriginal)
      expect(await readFile(captionedNote, 'utf8')).toBe(captionedOriginal)
    },
    30_000,
  )

  it('resolves document-wide link and image definitions in a captioned table', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) throw new Error('Typst is required for real PDF compilation')

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    await writeFile(join(root, 'photo.png'), Buffer.from(DOT_PNG, 'base64'))
    const notePath = join(root, 'references.md')
    const original = [
      writeMarkdownCaptionEnvelope(
        '| Link | Image | Literal |\n| --- | --- | --- |\n| [full][dest] [collapsed][] [shortcut] | ![Photo][photo] proof | #panic("literal") `<!--raw-typst #panic("inline")-->` |',
        'Reference caption.',
      ),
      '',
      '[dest]: https://example.com/\n  "A destination title"',
      '[collapsed]: https://example.org/',
      '[shortcut]: https://example.net/',
      '[photo]: photo.png "A real image"',
      '',
      '```markdown',
      '[code-only]: https://ignored.invalid/',
      '```',
      '',
      '    [indented-only]: https://ignored.invalid/',
      '',
      '<div>',
      '[html-only]: https://ignored.invalid/',
      '</div>',
    ].join('\n')
    await writeFile(notePath, original)
    const outPath = join(root, 'references.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })

    const pdf = await readFile(outPath)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const pdfText = pdf.toString('latin1')
    const imageCount = (bytes: Buffer) =>
      (bytes.toString('latin1').match(/\/Subtype\s*\/Image\b/g) ?? []).length
    const baselineNote = join(root, 'baseline.md')
    await writeFile(
      baselineNote,
      '| Link | Image | Literal |\n| --- | --- | --- |\n| text | no image | text |',
    )
    const baselinePdf = join(root, 'baseline.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath: baselineNote,
      outPath: baselinePdf,
      fields: [],
      meta: {},
    })
    expect(imageCount(pdf)).toBeGreaterThan(imageCount(await readFile(baselinePdf)))
    for (const destination of [
      'https://example.com/',
      'https://example.org/',
      'https://example.net/',
    ]) {
      expect(pdfText).toContain(`/URI (${destination})`)
    }
    const pages = await readPdfPages(outPath)
    const text = pages
      .flatMap((page) => page.runs)
      .map((run) => run.text)
      .join(' ')
    expect(text).toContain('full')
    expect(text).toContain('collapsed')
    expect(text).toContain('shortcut')
    expect(text).toContain('Reference caption.')
    const runs = pages.flatMap((page) => page.runs)
    const photo = runs.find((run) => run.text.includes('proof'))
    const caption = runs.find((run) => run.text.includes('Reference caption.'))
    expect(photo).toBeDefined()
    expect(caption).toBeDefined()
    expect(caption!.rect.origin.y).toBeGreaterThan(photo!.rect.origin.y)
    // Typst compiled the literal attack-shaped cell as text, not code.
    expect(text).toContain('#panic')
    expect(text).toContain('literal')
    expect(text).toContain('inline')
    expect(await readFile(notePath, 'utf8')).toBe(original)
    if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
      await cp(outPath, join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'reference-table.pdf'))
    }

    // Explicit user HTML forces the ordinary Markdown fallback. Preserve that
    // existing rendering contract rather than globally removing raw comments.
    const unsafeNote = join(root, 'unsafe.md')
    const unsafeSource = writeMarkdownCaptionEnvelope(
      '| Value |\n| --- |\n| <!--raw-typst [User raw fallback]--> |',
      'Unsafe comment fallback.',
    )
    await writeFile(unsafeNote, unsafeSource)
    const unsafePdf = join(root, 'unsafe.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath: unsafeNote,
      outPath: unsafePdf,
      fields: [],
      meta: {},
    })
    expect((await readFile(unsafePdf)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await readFile(unsafeNote, 'utf8')).toBe(unsafeSource)
    expect(
      (await readPdfPages(unsafePdf))
        .flatMap((page) => page.runs)
        .map((run) => run.text)
        .join(' '),
    ).toContain('User raw fallback')

    for (const [name, cell] of [['footnote', '[^note]']] as const) {
      const fallbackNote = join(root, `${name}.md`)
      const fallbackSource = writeMarkdownCaptionEnvelope(
        `| Value |\n| --- |\n| ${cell} |`,
        `${name} fallback caption.`,
      )
      await writeFile(fallbackNote, fallbackSource)
      const fallbackPdf = join(root, `${name}.pdf`)
      await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath: fallbackNote,
        outPath: fallbackPdf,
        fields: [],
        meta: {},
      })
      expect((await readFile(fallbackPdf)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(await readFile(fallbackNote, 'utf8')).toBe(fallbackSource)
    }

    // cmarker treats [@key] as a Typst citation, not a CommonMark link. Without
    // its required bibliography label it fails normally; it is never reinterpreted
    // as a portable table-cell reference by the caption adapter.
    const citationNote = join(root, 'citation.md')
    const citationSource = writeMarkdownCaptionEnvelope(
      '| Value |\n| --- |\n| [@citation] |',
      'Citation fallback.',
    )
    await writeFile(citationNote, citationSource)
    await expect(
      renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath: citationNote,
        outPath: join(root, 'citation.pdf'),
        fields: [],
        meta: {},
      }),
    ).rejects.toThrow('label `<citation>` does not exist')
    expect(await readFile(citationNote, 'utf8')).toBe(citationSource)
  }, 30_000)

  it.each([
    ['wiki-alias', '[[note.md|<]]!--raw-typst #panic("review")-->'],
    ['missing-image-alias', '![[missing.png|<]]!--raw-typst #panic("review")-->'],
    ['wiki-image-syntax', '[[note.md|![]]untrusted](must-not-be-read.png)'],
  ])(
    'never executes raw Typst assembled by %s in a captioned table',
    async (name, attack) => {
      const typst = await resolveTypstBin()
      if (typst === null) throw new Error('Typst is required for real PDF compilation')
      const root = await work()
      const templateDir = join(root, '.holi/document-templates/plain')
      await mkdir(templateDir, { recursive: true })
      await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
      await writeFile(join(root, 'photo.png'), Buffer.from(DOT_PNG, 'base64'))
      const notePath = join(root, `${name}.md`)
      const original = [
        '<!--raw-typst [User raw outside table]-->',
        '',
        writeMarkdownCaptionEnvelope(
          `| Text | Image |\n| --- | --- |\n| Visible cell ${attack} | ![Legitimate photo](photo.png) proof |\n| \`#panic("literal")\` | trailing cell |`,
          'Safe attached caption.',
        ),
      ].join('\n')
      await writeFile(notePath, original)
      const outPath = join(root, `${name}.pdf`)
      const result = await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
      })
      const pdf = await readFile(outPath)
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(pdf.toString('latin1')).toMatch(/\/Subtype\s*\/Image\b/)
      const pages = await readPdfPages(outPath)
      const runs = pages.flatMap((page) => page.runs)
      const text = runs.map((run) => run.text).join(' ')
      expect(text).toContain('Visible cell')
      expect(text).toContain('User raw outside table')
      expect(text).toContain('#panic')
      expect(text).toContain('literal')
      expect(text).toContain('trailing cell')
      expect(text).toContain('Safe attached caption.')
      const caption = runs.find((run) => run.text.includes('Safe attached caption.'))
      const lastCell = runs.find((run) => run.text.includes('trailing cell'))
      expect(caption!.rect.origin.y).toBeGreaterThan(lastCell!.rect.origin.y)
      expect(result.warnings.length).toBe(name === 'missing-image-alias' ? 1 : 0)
      expect(await readFile(notePath, 'utf8')).toBe(original)
      if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
        await cp(outPath, join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, `safe-${name}.pdf`))
      }
    },
    30_000,
  )

  it('matches ordinary table URIs for container, multiline, and escaped definitions', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) throw new Error('Typst is required for real PDF compilation')
    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const table = String.raw`| Reference | Value |
| --- | --- |
| [target] | blockquote continuation |
| [multi line] | nested multiline label and title |
| [escaped\]label] | escaped label and destination |
| [list] | list continuation |
| [spaced] | destination spaces |
| [hidden] [code-only] | hidden definitions stay hidden |`
    const definitions =
      String.raw`> [target]:
>   https://example.org/destination
>
> > [multi
> > line]: <https://example.org/multi> "title
> > with \"quotes\""

- [escaped\]label]: https://example.org/escaped\(path\) 'escaped title'
- [list]:
    https://example.org/list
    "continued title"

[spaced]: <https://example.org/a  b>
[target]: https://ignored.invalid/duplicate

<div>
[hidden]: https://ignored.invalid/html
</div>

` + '\n```markdown\n[code-only]: https://ignored.invalid/code\n```\n'
    const sources = [table, writeMarkdownCaptionEnvelope(table, 'Contextual reference caption.')]
    const uris: string[][] = []
    for (const [index, source] of sources.entries()) {
      const name = index === 0 ? 'contextual-reference-control' : 'contextual-reference-captioned'
      const notePath = join(root, `${name}.md`)
      const original = `${source}\n\n${definitions}`
      await writeFile(notePath, original)
      const outPath = join(root, `${name}.pdf`)
      await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
      })
      const pdf = (await readFile(outPath)).toString('latin1')
      uris.push([...pdf.matchAll(/\/URI \(([^\n]*)\)/g)].map((match) => match[1]!).sort())
      const text = (await readPdfPages(outPath))
        .flatMap((page) => page.runs)
        .map((run) => run.text)
        .join(' ')
      expect(text).toContain('target')
      expect(text).toContain('escaped')
      expect(await readFile(notePath, 'utf8')).toBe(original)
      if (index === 1) expect(text).toContain('Contextual reference caption.')
      if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
        await cp(outPath, join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, `${name}.pdf`))
      }
    }
    expect(uris[1]).toEqual(uris[0])
    expect(uris[1]).toHaveLength(5)
    expect(uris[1]!.join(' ')).toContain('https://example.org/destination')
    expect(uris[1]!.join(' ')).toContain('https://example.org/escaped')
    expect(uris[1]!.join(' ')).not.toContain('ignored.invalid')
  }, 30_000)

  it('shows a table caption on its own final page before later prose', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'later-prose.md')
    const rows = Array.from({ length: 250 }, (_, index) => `| EARLY-${index + 1} | value |`).join(
      '\n',
    )
    const caption = 'Caption before later pages.'
    await writeFile(
      notePath,
      `${writeMarkdownCaptionEnvelope(`| Item | Value |\n| --- | --- |\n${rows}`, caption)}\n\n${Array.from({ length: 140 }, (_, index) => `Later prose paragraph ${index + 1}.`).join('\n\n')}`,
    )
    const outPath = join(root, 'later-prose.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    const pages = await readPdfPages(outPath)
    const pageText = pages.map(({ runs }) => runs.map((run) => run.text).join(''))
    const normalizedText = pageText.map((text) => text.replace(/\s+/g, ' '))
    if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
      await cp(
        outPath,
        join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'caption-before-later-prose.pdf'),
      )
    }
    expect(normalizedText.join(' ')).toContain('Later prose paragraph 140.')
    expect(normalizedText.join(' ').match(/Caption before later pages\./g)).toHaveLength(1)
    const tableEndPage = normalizedText.findIndex((text) => text.includes('EARLY-250'))
    expect(tableEndPage).toBeGreaterThanOrEqual(0)
    expect(normalizedText[tableEndPage]).toContain(caption)
    expect(normalizedText.slice(tableEndPage + 1).join(' ')).toContain('Later prose paragraph')
  }, 30_000)

  it('keeps a caption on a header-only table', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'header-only.md')
    await writeFile(
      notePath,
      writeMarkdownCaptionEnvelope('| Header | Value |\n| --- | --- |', 'Header-only caption.'),
    )
    const outPath = join(root, 'header-only.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    const pages = await readPdfPages(outPath)
    const normalizedText = pages.map(({ runs }) =>
      runs
        .map((run) => run.text)
        .join('')
        .replace(/\s+/g, ' '),
    )
    expect(normalizedText.join(' ')).toContain('Header-only caption.')
    expect(normalizedText.filter((text) => text.includes('Header-only caption.'))).toHaveLength(1)
    const runs = pages.flatMap((page) => page.runs)
    const header = runs.find((run) => run.text.trim() === 'Header')
    const value = runs.find((run) => run.text.trim() === 'Value')
    const captionRuns = runs.filter((run) => /Header-only|caption\./i.test(run.text))
    expect(header).toBeDefined()
    expect(value).toBeDefined()
    expect(captionRuns.length).toBeGreaterThan(0)
    const tableCenter = (header!.rect.origin.x + value!.rect.origin.x + value!.rect.size.width) / 2
    const captionLeft = Math.min(...captionRuns.map((run) => run.rect.origin.x))
    const captionRight = Math.max(
      ...captionRuns.map((run) => run.rect.origin.x + run.rect.size.width),
    )
    expect(Math.abs((captionLeft + captionRight) / 2 - tableCenter)).toBeLessThan(70)
    expect(Math.min(...captionRuns.map((run) => run.rect.origin.y))).toBeGreaterThan(
      header!.rect.origin.y,
    )
  }, 30_000)

  it('retains wiki images in table-caption fallback and supports text wiki-links', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    await writeFile(join(root, 'dot.png'), Buffer.from(DOT_PNG, 'base64'))

    const render = async (name: string, markdown: string) => {
      const notePath = join(root, `${name}.md`)
      const outPath = join(root, `${name}.pdf`)
      await writeFile(notePath, markdown)
      await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
      })
      const pdf = await readFile(outPath)
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      return { pdf, pages: await readPdfPages(outPath), original: await readFile(notePath, 'utf8') }
    }
    const imageCount = (pdf: Buffer) =>
      (pdf.toString('latin1').match(/\/Subtype\s*\/Image\b/g) ?? []).length
    for (const [name, image] of [
      ['aliased-wiki-image', '[[dot.png|photo]]'],
      ['embedded-wiki-image', '![[dot.png|photo]]'],
    ] as const) {
      const captionedSource = writeMarkdownCaptionEnvelope(
        `| Image |\n| --- |\n| ${image} |`,
        'Image caption.',
      )
      const captioned = await render(name, captionedSource)
      const control = await render(`${name}-control`, `| Image |\n| --- |\n| ${image} |`)
      expect(imageCount(captioned.pdf)).toBeGreaterThan(0)
      expect(imageCount(captioned.pdf)).toBe(imageCount(control.pdf))
      expect(captioned.original).toBe(captionedSource)
    }

    for (const [name, link, visible] of [
      ['unaliased-text-wiki', '[[notes/plan.md]]', 'plan'],
      ['aliased-text-wiki', '[[notes/plan.md|Project plan]]', 'Project'],
    ] as const) {
      const textWikiSource = writeMarkdownCaptionEnvelope(
        `| Plan |\n| --- |\n| ${link} |`,
        'Text wiki-link caption.',
      )
      const textWiki = await render(name, textWikiSource)
      const runs = textWiki.pages.flatMap((page) => page.runs)
      const linkedText = runs.find((run) => run.text.includes(visible))
      const caption = runs.find((run) => run.text.includes('Text'))
      expect(linkedText).toBeDefined()
      expect(caption).toBeDefined()
      expect(caption!.rect.origin.y).toBeGreaterThan(linkedText!.rect.origin.y)
      expect(textWiki.original).toBe(textWikiSource)
    }
  }, 30_000)

  it('shows captions for independent tables on their respective final pages', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'two-tables.md')
    const table = (prefix: string) => {
      const rows = Array.from(
        { length: 220 },
        (_, index) => `| ${prefix}-${index + 1} | value |`,
      ).join('\n')
      return writeMarkdownCaptionEnvelope(
        `| Item | Value |\n| --- | --- |\n${rows}`,
        `${prefix} caption.`,
      )
    }
    await writeFile(
      notePath,
      `${table('FIRST')}\n\nBridge prose between tables.\n\n${table('SECOND')}`,
    )
    const outPath = join(root, 'two-tables.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    const pages = await readPdfPages(outPath)
    const pageText = pages.map(({ runs }) => runs.map((run) => run.text).join(''))
    const normalizedText = pageText.map((text) => text.replace(/\s+/g, ' '))
    const allText = normalizedText.join(' ')
    expect(allText.match(/FIRST caption\./g)).toHaveLength(1)
    expect(allText.match(/SECOND caption\./g)).toHaveLength(1)
    const firstEnd = normalizedText.findIndex((text) => text.includes('FIRST-220'))
    const secondEnd = normalizedText.findIndex((text) => text.includes('SECOND-220'))
    expect(firstEnd).toBeGreaterThanOrEqual(0)
    expect(secondEnd).toBeGreaterThan(firstEnd)
    expect(normalizedText[firstEnd]).toContain('FIRST caption.')
    expect(normalizedText[secondEnd]).toContain('SECOND caption.')
    expect(normalizedText.filter((text) => text.includes('FIRST caption.'))).toHaveLength(1)
    expect(normalizedText.filter((text) => text.includes('SECOND caption.'))).toHaveLength(1)
    if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
      await cp(outPath, join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'two-captioned-tables.pdf'))
    }
  }, 30_000)

  it('centers every wrapped caption line within a narrow two-column table', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'narrow.md')
    const caption =
      'A narrow table caption wraps onto several lines; every line must remain centered instead of leaving its final short line against the left edge.'
    await writeFile(
      notePath,
      writeMarkdownCaptionEnvelope('| A | B |\n| --- | --- |\n| x | y |', caption),
    )
    const outPath = join(root, 'narrow.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    const pages = await readPdfPages(outPath)
    if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
      await cp(
        outPath,
        join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'wrapped-caption-centering.pdf'),
      )
    }
    const runs = pages.flatMap((page) => page.runs)
    const headerA = runs.find((run) => run.text.trim() === 'A')
    const headerB = runs.find((run) => run.text.trim() === 'B')
    expect(headerA).toBeDefined()
    expect(headerB).toBeDefined()
    const tableCenter =
      (headerA!.rect.origin.x + headerB!.rect.origin.x + headerB!.rect.size.width) / 2
    const captionRuns = runs.filter((run) =>
      /narrow|caption|wraps|onto|several|lines|centered|short|against/.test(run.text),
    )
    const lines = new Map<number, typeof captionRuns>()
    for (const run of captionRuns) {
      const y = Math.round(run.rect.origin.y)
      lines.set(y, [...(lines.get(y) ?? []), run])
    }
    expect(lines.size).toBeGreaterThan(1)
    for (const line of lines.values()) {
      const left = Math.min(...line.map((run) => run.rect.origin.x))
      const right = Math.max(...line.map((run) => run.rect.origin.x + run.rect.size.width))
      expect(Math.abs((left + right) / 2 - tableCenter)).toBeLessThan(12)
    }
  }, 30_000)

  it.each([31, 32])(
    'keeps the final table row with its wrapped caption after %i short paragraphs',
    async (paragraphCount) => {
      const typst = await resolveTypstBin()
      if (typst === null) return

      const root = await work()
      const templateDir = join(root, '.holi/document-templates/plain')
      await mkdir(templateDir, { recursive: true })
      await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
      const fillers = Array.from(
        { length: paragraphCount },
        (_, index) => `Filler ${index + 1}.`,
      ).join('\n\n')
      const notePath = join(root, 'boundary.md')
      await writeFile(
        notePath,
        `${fillers}\n\n${writeMarkdownCaptionEnvelope(
          '| Item | Value |\n| --- | --- |\n| LAST-ROW | FINAL-VALUE |',
          'This long ordinary caption wraps across multiple lines and describes the final row of the table in detail for readers.',
        )}`,
      )
      const outPath = join(root, 'boundary.pdf')
      await renderPdf({
        typstBin: typst,
        vaultRoot: root,
        templateDir,
        notePath,
        outPath,
        fields: [],
        meta: {},
      })
      const pages = await readPdfPages(outPath)
      if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
        await cp(
          outPath,
          join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, `caption-boundary-${paragraphCount}.pdf`),
        )
      }
      const rowPage = pages.findIndex(({ runs }) =>
        runs.some((run) => run.text.includes('LAST-ROW')),
      )
      const captionPage = pages.findIndex(({ runs }) =>
        runs.some((run) => run.text.includes('ordinary')),
      )
      expect(rowPage).toBeGreaterThanOrEqual(0)
      expect(captionPage).toBe(rowPage)
      expect(pages[rowPage]!.runs.some((run) => run.text.includes('Item'))).toBe(true)
      expect(pages[rowPage]!.runs.some((run) => run.text.includes('FINAL-VALUE'))).toBe(true)
      expect(pages[rowPage]!.runs.some((run) => run.text.includes('ordinary'))).toBe(true)
      expect(pages.every(({ runs }) => runs.some((run) => run.text.trim().length > 0))).toBe(true)
    },
  )

  it('renders table captions through branded and custom scoped templates', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateRoot = join(root, '.holi/document-templates')
    for (const slug of ['_brand', 'proposal']) {
      await cp(join(SRC_TEMPLATES, slug), join(templateRoot, slug), { recursive: true })
    }
    const notePath = join(root, 'table.md')
    await writeFile(
      notePath,
      writeMarkdownCaptionEnvelope(
        '| Name | Value |\n|:---|---:|\n| Alpha | 1 |',
        'Branded caption.',
      ),
    )
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir: join(root, '.holi/document-templates/proposal'),
      notePath,
      outPath: join(root, 'proposal.pdf'),
      fields: [],
      meta: {},
    })
    expect((await readFile(join(root, 'proposal.pdf'))).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    )

    const custom = join(root, 'custom-template')
    await mkdir(custom)
    await writeFile(
      join(custom, 'template.typ'),
      '#import "@preview/cmarker:0.1.6"\n#let doc(notePath, meta: (:), assets: "") = cmarker.render(read(notePath), scope: (table: table.with(fill: yellow, inset: 12pt)))\n',
    )
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir: custom,
      notePath,
      outPath: join(root, 'custom.pdf'),
      fields: [],
      meta: {},
    })
    expect((await readFile(join(root, 'custom.pdf'))).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    )
    if (process.env.HOLI_PDF_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, { recursive: true })
      await cp(
        join(root, 'custom.pdf'),
        join(process.env.HOLI_PDF_TEST_ARTIFACT_DIR, 'custom-table-caption-scope.pdf'),
      )
    }
    const customCaptionedPages = await readPdfPages(join(root, 'custom.pdf'))
    const customCaptionedRuns = customCaptionedPages.flatMap((page) => page.runs)
    const customAlpha = customCaptionedRuns.find((run) => run.text.trim() === 'Alpha')
    const customValue = customCaptionedRuns.find((run) => run.text.trim() === '1')
    const customHeaderValue = customCaptionedRuns.find((run) => run.text.trim() === 'Value')
    const customCaption = customCaptionedRuns.find((run) => /Branded|caption/.test(run.text))
    expect(customAlpha).toBeDefined()
    expect(customValue).toBeDefined()
    expect(customHeaderValue).toBeDefined()
    expect(customCaption).toBeDefined()
    expect(customCaption!.rect.origin.y).toBeGreaterThan(customAlpha!.rect.origin.y)

    const plain = join(root, '.holi/document-templates/plain')
    await mkdir(plain, { recursive: true })
    await writeFile(join(plain, 'template.typ'), plainTemplateTyp)
    const uncaptained = join(root, 'uncaptioned.md')
    await writeFile(uncaptained, '| Name | Value |\n|:---|---:|\n| Alpha | 1 |')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir: custom,
      notePath: uncaptained,
      outPath: join(root, 'custom-uncaptioned.pdf'),
      fields: [],
      meta: {},
    })
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir: plain,
      notePath: uncaptained,
      outPath: join(root, 'plain-uncaptioned.pdf'),
      fields: [],
      meta: {},
    })
    const customUncaptionedRuns = (
      await readPdfPages(join(root, 'custom-uncaptioned.pdf'))
    ).flatMap((page) => page.runs)
    const plainUncaptionedRuns = (await readPdfPages(join(root, 'plain-uncaptioned.pdf'))).flatMap(
      (page) => page.runs,
    )
    const customAlphaX = customUncaptionedRuns.find((run) => run.text.trim() === 'Alpha')!.rect
      .origin.x
    const plainAlphaX = plainUncaptionedRuns.find((run) => run.text.trim() === 'Alpha')!.rect.origin
      .x
    expect(customAlpha!.rect.origin.x).toBeCloseTo(customAlphaX, 0)
    expect(customAlphaX).toBeGreaterThan(plainAlphaX + 5)
    expect(customValue!.rect.origin.x + customValue!.rect.size.width).toBeCloseTo(
      customHeaderValue!.rect.origin.x + customHeaderValue!.rect.size.width,
      0,
    )
  }, 30_000)

  it('centers a caption below its unaltered code and leaves the source note untouched', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'caption.md')
    const original = `Before.\n\n${writeMarkdownCaptionEnvelope(
      '~~~typescript extra-info\nconst value = 1\n~~~',
      'A **portable** caption. Pending reload',
    )}\n\nAfter [[other.md|link]].\n`
    await writeFile(notePath, original)
    const outPath = join(root, 'caption.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    expect((await readFile(outPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await readFile(notePath, 'utf8')).toBe(original)
  }, 30_000)

  it('keeps a caption below a Mermaid diagram and its unavailable-source fallback', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'diagram.md')
    const original = writeMarkdownCaptionEnvelope(
      '```mermaid\nflowchart LR\n  A --> B\n```',
      '**Diagram caption**',
    )
    await writeFile(notePath, original)
    const diagramOut = join(root, 'diagram.pdf')
    const diagram = await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: diagramOut,
      fields: [],
      meta: {},
      diagrams: async (sources) => {
        expect(sources).toEqual(['flowchart LR\n  A --> B'])
        return [
          {
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="30"><text x="2" y="20">Diagram 478</text></svg>',
          },
        ]
      },
    })
    expect(diagram.warnings).toEqual([])
    expect((await readFile(diagramOut)).subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const fallback = await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: join(root, 'fallback.pdf'),
      fields: [],
      meta: {},
      diagrams: async () => [{ error: 'invalid source' }],
    })
    expect(fallback.warnings).toEqual(['The diagram on line 3 shows as code: invalid source'])
    expect(await readFile(notePath, 'utf8')).toBe(original)
  }, 30_000)

  it('renders safely through an unchanged custom cmarker template', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/custom')
    await mkdir(templateDir, { recursive: true })
    await writeFile(
      join(templateDir, 'template.typ'),
      '#import "@preview/cmarker:0.1.6"\n#let doc(notePath, meta: (:), assets: "") = cmarker.render(read(notePath))\n',
    )
    const notePath = join(root, 'custom.md')
    const original = writeMarkdownCaptionEnvelope(
      '```js\nconst marker = "@@FIG:kept@@";\n```',
      'Custom **caption** &amp; text.',
    )
    await writeFile(notePath, original)
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: join(root, 'custom.pdf'),
      fields: [],
      meta: {},
    })
    expect((await readFile(join(root, 'custom.pdf'))).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    )
    expect(await readFile(notePath, 'utf8')).toBe(original)
  }, 30_000)

  it('keeps image and diagram warning lines mapped to the original note', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    const notePath = join(root, 'warnings.md')
    const envelope = writeMarkdownCaptionEnvelope('```js\nconst x = 1\n```', 'Caption')
    const original = [
      '![Before](before.png)',
      '',
      envelope,
      '',
      '```mermaid',
      'not a diagram',
      '```',
      '',
      '![After](after.png)',
      '',
    ].join('\n')
    await writeFile(notePath, original)
    const result = await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: join(root, 'warnings.pdf'),
      fields: [],
      meta: {},
      diagrams: async () => [{ error: 'intentional invalid diagram' }],
    })
    expect(result.warnings).toEqual([
      'The image on line 1 is left out: before.png: no such file in the vault',
      'The diagram on line 15 shows as code: intentional invalid diagram',
      'The image on line 19 is left out: after.png: no such file in the vault',
    ])
  }, 30_000)

  it('shows an image the note links relative to its own folder', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    await mkdir(join(root, 'kunder/figurer'), { recursive: true })
    await writeFile(join(root, 'kunder/figurer/dot.png'), Buffer.from(DOT_PNG, 'base64'))
    const notePath = join(root, 'kunder/rapport.md')
    await writeFile(notePath, '# Rapport\n\n![Et diagram](figurer/dot.png)\n')

    const { warnings } = await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: join(root, 'out.pdf'),
      fields: [],
      meta: {},
    })
    expect(warnings).toEqual([])
    expect((await readFile(join(root, 'out.pdf'))).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)

  it('still makes the PDF when an image is broken, and says which', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/document-templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)
    await writeFile(join(root, 'bad.png'), 'not a png')
    const notePath = join(root, 'n.md')
    await writeFile(notePath, '![Broken](bad.png)\n\n![Gone](gone.png)\n')

    const { warnings } = await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: join(root, 'out.pdf'),
      fields: [],
      meta: {},
    })
    expect(warnings).toEqual([
      'The image on line 1 is left out: bad.png is not a png file',
      'The image on line 3 is left out: gone.png: no such file in the vault',
    ])
    expect((await readFile(join(root, 'out.pdf'))).subarray(0, 5).toString('latin1')).toBe('%PDF-')
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
      vaultRoot: root,
      templateDir,
      notePath,
      outPath: emptyOut,
      fields: [...fields],
      meta: {},
    })
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
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
      vaultRoot: root,
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
const SRC_TEMPLATES = fileURLToPath(
  new URL('../main/vault/once/.holi/document-templates', import.meta.url),
)

describeTypst('renderPdf — branded set (integration — needs typst)', () => {
  async function vaultWithBrandedSet(): Promise<string> {
    const root = await work()
    const dt = join(root, '.holi/document-templates')
    for (const slug of ['_brand', 'proposal', 'report', 'letter', 'memo', 'contract']) {
      await cp(join(SRC_TEMPLATES, slug), join(dt, slug), { recursive: true })
    }
    return root
  }

  it('keeps a captioned source literal through the unchanged branded template', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await vaultWithBrandedSet()
    const notePath = join(root, 'caption.md')
    const original = writeMarkdownCaptionEnvelope(
      '```javascript title="source.js"\nconst link = "[[folder/file.md|shown]]"; // @@FIG:kept@@\n```',
      '**Source caption** with `inline` formatting.',
    )
    await writeFile(notePath, original)
    const outPath = join(root, 'caption.pdf')
    const result = await renderPdf({
      typstBin: typst,
      vaultRoot: root,
      templateDir: join(root, '.holi/document-templates/proposal'),
      notePath,
      outPath,
      fields: [],
      meta: {},
    })
    expect(result.warnings).toEqual([])
    expect((await readFile(outPath)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await readFile(notePath, 'utf8')).toBe(original)
  }, 30_000)

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
      vaultRoot: root,
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
      vaultRoot: root,
      templateDir: join(root, '.holi/document-templates/letter'),
      notePath: letterNote,
      outPath: letterOut,
      fields: [
        { key: 'recipient', label: 'Recipient', type: 'text', required: false },
        { key: 'date', label: 'Date', type: 'date', required: false },
        { key: 'closing', label: 'Closing', type: 'text', required: false },
        { key: 'sender', label: 'Sender', type: 'text', required: false },
      ],
      meta: {
        recipient: 'ACME A/S',
        date: '2026-07-08',
        closing: 'Med venlig hilsen',
        sender: 'Ada',
      },
    })
    expect((await readFile(letterOut)).subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const memoNote = join(root, 'memo.md')
    await writeFile(memoNote, '# n\n\nHusk deadline på fredag.\n')
    const memoOut = join(root, 'memo.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
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
      vaultRoot: root,
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
    await writeFile(
      notePath,
      '---\nx: 1\n---\n\n# Rapport\n\n## Indledning\n\nBrødtekst.\n\n## Metode\n\nMere.\n',
    )
    const outPath = join(root, 'rapport.pdf')
    await renderPdf({
      typstBin: typst,
      vaultRoot: root,
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
