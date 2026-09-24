/**
 * The main reader against real PDFs: one saved by embedpdf the way the viewer
 * saves, and one written the way Acrobat and most editors write (compressed
 * object streams, UTF-16 strings, no `/EPDFCustom`). Both are made by
 * `fixtures/pdf-comments/make-fixtures.cjs`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readPdfComments } from '../src/main/pdf/comments'

const FIXTURES = join(__dirname, 'fixtures', 'pdf-comments')

async function threads(name: string) {
  const result = await readPdfComments(join(FIXTURES, name))
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result.threads
}

describe('readPdfComments', () => {
  it('reads a PDF saved by embedpdf: marks in page order, a reply under its mark', async () => {
    const [highlight, note, ...rest] = await threads('embedpdf.pdf')
    expect(rest).toEqual([])
    expect(highlight).toMatchObject({
      id: 'hl-payment',
      page: 1,
      kind: 'highlight',
      markedText: 'Payment within 60 days of invoice.',
      author: 'Ada Holm',
      text: 'Should be 30 days, per our terms.',
    })
    expect(highlight!.created?.toISOString()).toBe('2026-09-22T14:10:00.000Z')
    expect(highlight!.replies).toHaveLength(1)
    expect(highlight!.replies[0]).toMatchObject({
      id: 'reply-payment',
      author: 'Bo Lind',
      text: 'Agreed.',
    })
    expect(highlight!.replies[0]!.created?.toISOString()).toBe('2026-09-22T15:02:00.000Z')
    expect(note).toMatchObject({
      kind: 'note',
      author: 'Bo Lind',
      text: 'Is this clause standard?\nOur template says 90 days.',
      markedText: null,
    })
  })

  it('reads a mark another tool wrote: UTF-16 names, and the marked text from the page', async () => {
    const [highlight, ...rest] = await threads('other-tool.pdf')
    expect(rest).toEqual([])
    expect(highlight).toMatchObject({
      id: 'acro-hl-1',
      kind: 'highlight',
      author: 'Åse Holm',
      text: 'Skal det være 30 dage?',
      markedText: 'Payment within 60 days',
    })
  })

  describe('refusals', () => {
    let dir: string
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'holi-pdf-comments-'))
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('says a missing file is not found', async () => {
      expect(await readPdfComments(join(dir, 'nope.pdf'))).toEqual({
        ok: false,
        reason: 'not-found',
      })
    })

    it('says a file PDFium cannot open is not a PDF', async () => {
      const junk = join(dir, 'junk.pdf')
      await writeFile(junk, 'this is not a pdf')
      expect(await readPdfComments(junk)).toEqual({ ok: false, reason: 'not-pdf' })
    })
  })
})
