/**
 * Makes the two PDFs `test/pdf-comments.test.ts` reads. Committed so they can
 * be regenerated rather than trusted:
 *
 *   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/.bin/electron \
 *     apps/desktop/test/fixtures/pdf-comments/make-fixtures.cjs
 *
 * (Electron as Node because a bare `node` is not reliably on this machine's
 * PATH; any Node 20+ that can resolve `@embedpdf/*` from apps/desktop works.)
 *
 * - `embedpdf.pdf`: saved by embedpdf's own engine, the way the viewer saves: a
 *   highlight carrying `custom.text` (written as `/EPDFCustom`), a text note,
 *   and a reply to the highlight (a text note with `/IRT`).
 * - `other-tool.pdf`: the same base page plus an incremental update written by
 *   hand the way Acrobat and most editors write: the highlight inside a
 *   Flate-compressed object stream, a cross-reference stream, author and comment
 *   as UTF-16BE strings, and no `/EPDFCustom`, so its marked text can only be
 *   recovered from the page's glyphs.
 *
 * Every name here is invented. Fixtures must never carry a real name or login.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { init } = require('@embedpdf/pdfium')
const { PdfiumNative } = require('@embedpdf/engines/pdfium')

const OUT = __dirname
const PAGE_HEIGHT = 792
const LINES = [
  [720, 'Master Services Agreement'],
  [690, 'Payment within 60 days of invoice.'],
  [660, 'Either party may terminate on notice.'],
]

/** A one-page PDF with three lines of Helvetica, offsets computed. */
function basePdf() {
  const text = LINES.map(([y, s]) => `BT /F1 12 Tf 72 ${y} Td (${s}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${PAGE_HEIGHT}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const arrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

/** The bounding box, top-left origin, of the first occurrence of `needle` on page 0. */
async function boxOf(engine, doc, needle) {
  const page = doc.pages[0]
  const glyphs = await engine.getPageGlyphs(doc, page).toPromise()
  const [all] = await engine
    .getTextSlices(doc, [{ pageIndex: 0, charIndex: 0, charCount: glyphs.length }])
    .toPromise()
  const start = all.indexOf(needle)
  if (start < 0) throw new Error(`"${needle}" is not on the page`)
  const hit = glyphs.slice(start, start + needle.length).filter((g) => g.size.width > 0)
  const x1 = Math.min(...hit.map((g) => g.origin.x))
  const y1 = Math.min(...hit.map((g) => g.origin.y))
  const x2 = Math.max(...hit.map((g) => g.origin.x + g.size.width))
  const y2 = Math.max(...hit.map((g) => g.origin.y + g.size.height))
  return { origin: { x: x1, y: y1 }, size: { width: x2 - x1, height: y2 - y1 } }
}

async function embedpdfFixture(engine, base) {
  const doc = await engine
    .openDocumentBuffer({ id: 'embedpdf', content: arrayBuffer(base) })
    .toPromise()
  const page = doc.pages[0]
  const marked = 'Payment within 60 days of invoice.'
  const box = await boxOf(engine, doc, marked)
  const at = (iso) => new Date(iso)
  await engine
    .createPageAnnotation(doc, page, {
      type: 9,
      id: 'hl-payment',
      pageIndex: 0,
      rect: box,
      segmentRects: [box],
      strokeColor: '#FFCD45',
      opacity: 1,
      author: 'Ada Holm',
      created: at('2026-09-22T14:10:00Z'),
      modified: at('2026-09-22T14:10:00Z'),
      contents: 'Should be 30 days, per our terms.',
      custom: { text: marked },
    })
    .toPromise()
  const noteBox = await boxOf(engine, doc, 'terminate')
  await engine
    .createPageAnnotation(doc, page, {
      type: 1,
      id: 'note-terminate',
      pageIndex: 0,
      rect: { origin: noteBox.origin, size: { width: 20, height: 20 } },
      author: 'Bo Lind',
      created: at('2026-09-23T09:41:00Z'),
      modified: at('2026-09-23T09:41:00Z'),
      contents: 'Is this clause standard?\nOur template says 90 days.',
      flags: ['print', 'noZoom', 'noRotate'],
    })
    .toPromise()
  await engine
    .createPageAnnotation(doc, page, {
      type: 1,
      id: 'reply-payment',
      pageIndex: 0,
      rect: { origin: box.origin, size: { width: 20, height: 20 } },
      author: 'Bo Lind',
      created: at('2026-09-22T15:02:00Z'),
      modified: at('2026-09-22T15:02:00Z'),
      contents: 'Agreed.',
      inReplyToId: 'hl-payment',
      flags: ['print', 'noZoom', 'noRotate'],
    })
    .toPromise()
  const saved = await engine.saveAsCopy(doc).toPromise()
  await engine.closeDocument(doc).toPromise()
  return Buffer.from(saved)
}

/** A PDF text string as UTF-16BE with a BOM, in hex: how Acrobat writes names. */
const utf16 = (s) => {
  const le = Buffer.from(s, 'utf16le')
  for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]]
  return `<FEFF${le.toString('hex').toUpperCase()}>`
}

async function otherToolFixture(engine, base) {
  const doc = await engine
    .openDocumentBuffer({ id: 'probe', content: arrayBuffer(base) })
    .toPromise()
  // Only part of the line, to prove the recovery is by position and not by line.
  const b = await boxOf(engine, doc, 'Payment within 60 days')
  await engine.closeDocument(doc).toPromise()
  const x1 = b.origin.x
  const x2 = b.origin.x + b.size.width
  const top = PAGE_HEIGHT - b.origin.y
  const bottom = PAGE_HEIGHT - (b.origin.y + b.size.height)
  const n = (v) => v.toFixed(2)

  // New objects: 6 the highlight, 7 the object stream, 8 the xref stream; 3 (the
  // page) is rewritten inside the object stream with its /Annots.
  const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${PAGE_HEIGHT}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>`
  const highlight =
    `<< /Type /Annot /Subtype /Highlight /P 3 0 R /F 4 /NM (acro-hl-1)` +
    ` /Rect [${n(x1)} ${n(bottom)} ${n(x2)} ${n(top)}]` +
    ` /QuadPoints [${n(x1)} ${n(top)} ${n(x2)} ${n(top)} ${n(x1)} ${n(bottom)} ${n(x2)} ${n(bottom)}]` +
    ` /C [1 0.8 0] /CA 1 /T ${utf16('Åse Holm')} /Contents ${utf16('Skal det være 30 dage?')}` +
    ` /CreationDate (D:20260921101500Z) /M (D:20260921101500Z) >>`
  const members = [
    [3, page],
    [6, highlight],
  ]
  let header = ''
  let bodies = ''
  for (const [num, body] of members) {
    header += `${num} ${Buffer.byteLength(bodies, 'latin1')} `
    bodies += body + '\n'
  }
  const objStmData = zlib.deflateSync(Buffer.from(header + bodies, 'latin1'))
  const first = Buffer.byteLength(header, 'latin1')

  const prevXref = Number(/startxref\s+(\d+)/.exec(base.toString('latin1'))[1])
  const parts = [base]
  let offset = base.length
  const push = (buf) => {
    parts.push(buf)
    offset += buf.length
  }
  const objStmOffset = offset
  push(
    Buffer.from(
      `7 0 obj\n<< /Type /ObjStm /N ${members.length} /First ${first} /Filter /FlateDecode /Length ${objStmData.length} >>\nstream\n`,
      'latin1',
    ),
  )
  push(objStmData)
  push(Buffer.from('\nendstream\nendobj\n', 'latin1'))
  const xrefOffset = offset

  // /W [1 4 2]: type, offset or object-stream number, generation or index.
  const row = (type, a, b) => {
    const r = Buffer.alloc(7)
    r.writeUInt8(type, 0)
    r.writeUInt32BE(a, 1)
    r.writeUInt16BE(b, 5)
    return r
  }
  const rows = Buffer.concat([
    row(2, 7, 0), // 3: the page, first in the stream
    row(2, 7, 1), // 6: the highlight, second
    row(1, objStmOffset, 0), // 7: the object stream
    row(1, xrefOffset, 0), // 8: this xref stream
  ])
  const xrefData = zlib.deflateSync(rows)
  push(
    Buffer.from(
      `8 0 obj\n<< /Type /XRef /Size 9 /Root 1 0 R /Prev ${prevXref} /Index [3 1 6 3] /W [1 4 2] /Filter /FlateDecode /Length ${xrefData.length} >>\nstream\n`,
      'latin1',
    ),
  )
  push(xrefData)
  push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

;(async () => {
  const wasmBinary = fs.readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  const mod = await init({ wasmBinary })
  mod.PDFiumExt_Init()
  const engine = new PdfiumNative(mod)
  const base = basePdf()
  fs.writeFileSync(path.join(OUT, 'embedpdf.pdf'), await embedpdfFixture(engine, base))
  fs.writeFileSync(path.join(OUT, 'other-tool.pdf'), await otherToolFixture(engine, base))
  console.log('wrote embedpdf.pdf and other-tool.pdf')
})()
