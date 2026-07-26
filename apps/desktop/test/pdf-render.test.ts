import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderPdf } from '../src/main/pdf/render'
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

describe('renderPdf (integration — needs typst on PATH; first run fetches cmarker)', () => {
  it('renders a real markdown note through the Plain template to a %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst on this machine — skip, don't fail

    const root = await work()
    const templateDir = join(root, '.holi/templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)

    const notePath = join(root, 'report.md')
    await writeFile(
      notePath,
      '---\ntitle: T\n---\n\n## 1. Heading\n\nBody **bold** text and a list:\n\n- a\n- b\n',
    )
    const outPath = join(root, 'out.pdf')

    await renderPdf({ typstBin: typst, templateDir, notePath, outPath, meta: {} })

    const bytes = await readFile(outPath)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
})
