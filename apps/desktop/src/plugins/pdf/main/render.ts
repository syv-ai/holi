import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  isMachineStatePath,
  isSecretPath,
  readMarkdownCaptionEnvelopes,
  readMarkdownCodeCaptions,
  wikiLinksToText,
} from '@holi/shared'
import { resolveRelative } from '@holi/shared/path-safety-node'
import type { TemplateField } from '../shared/template-fields'
import { inlineImages } from './images'
import { commentSafeString, drawMermaid, type DrawDiagrams } from './mermaid'
import { composeWrapper } from './wrapper'
import { readMarkdownTableCaptions } from './table-captions'

const exec = promisify(execFile)

/**
 * `--font-path` args for a template, or `[]`. The branded templates (proposal,
 * report) render with Raleway, which the seeded `_brand/fonts` sibling holds;
 * `plain` ships none and a vault not yet re-seeded has no `_brand` at all, so
 * this is guarded on existence — a missing dir would make typst error rather
 * than fall back to its defaults.
 * @public exported for its test
 */
export function fontPathArgs(templateDir: string): string[] {
  const fontsDir = join(templateDir, '..', '_brand', 'fonts')
  return existsSync(fontsDir) ? ['--font-path', fontsDir] : []
}

export interface RenderInput {
  /** Absolute path to the typst binary (from resolveTypstBin/ensureTypst). */
  typstBin: string
  /** The vault the note is in: its images are read from here and nowhere else. */
  vaultRoot: string
  /** Absolute `.holi/document-templates/<name>/`. */
  templateDir: string
  /** The template's `language`, handed to Typst as `--input lang=…`. */
  language?: string
  /** Absolute path to the note. */
  notePath: string
  /** Absolute `.pdf` destination. */
  outPath: string
  /** The template's declared fields — drives meta coercion in the wrapper. */
  fields: TemplateField[]
  meta: Record<string, string>
  /** Draws the note's mermaid fences. Absent, they stay code blocks. */
  diagrams?: DrawDiagrams
}

export interface RenderResult {
  /** What did not come out as written, for the person: an image left out, a
   *  diagram mermaid could not draw. Empty when everything did. */
  warnings: string[]
}

/**
 * An image's bytes from the vault at `root`, by vault path: symlinks resolved
 * and kept inside the vault, and never a secret or machine-state file, as
 * given or as resolved, since the PDF may be committed or shared.
 */
async function readVaultImage(root: string, rel: string): Promise<Uint8Array> {
  const realRoot = await realpath(root)
  const abs = await resolveRelative(realRoot, rel)
  for (const p of [rel, relative(realRoot, abs).split(sep).join('/')]) {
    if (isSecretPath(p) || isMachineStatePath(p)) throw new Error('a secret or machine-state file')
  }
  return readFile(abs).catch((err: NodeJS.ErrnoException) => {
    throw new Error(err.code === 'ENOENT' ? 'no such file in the vault' : err.message)
  })
}

/**
 * Compose a wrapper in a fresh temp dir and run `typst compile`, producing
 * `outPath`. `--root /` because the wrapper (temp dir), the template, and the
 * note live in three different trees and the wrapper references them all by
 * absolute path — no single narrower root spans them. Throws with typst's
 * stderr on a non-zero exit. `--font-path` is added (via `fontPathArgs`) when the
 * template has a seeded `_brand/fonts` sibling — the branded templates' Raleway.
 * An image that cannot be shown, or a mermaid diagram that will not draw, does
 * not fail the PDF: the image leaves its alt text, the diagram stays code, and
 * the result says so.
 */
function wikiLinksOutsideRawTypst(markdown: string): string {
  const ranges = [...markdown.matchAll(/<!--raw-typst[\s\S]*?-->/g)]
    .map((match) => ({ from: match.index!, to: match.index! + match[0].length }))
    .sort((a, b) => a.from - b.from)
  if (ranges.length === 0) return wikiLinksToText(markdown)
  let protectedMarkdown = ''
  let at = 0
  const saved: string[] = []
  let prefix = 'HOLI_LITERAL_'
  while (markdown.includes(prefix)) prefix += 'X'
  for (const range of ranges) {
    if (range.from < at) continue
    protectedMarkdown += markdown.slice(at, range.from)
    const token = `${prefix}${saved.length}_END`
    saved.push(markdown.slice(range.from, range.to))
    protectedMarkdown += token
    at = range.to
  }
  protectedMarkdown += markdown.slice(at)
  protectedMarkdown = wikiLinksToText(protectedMarkdown)
  return protectedMarkdown.replace(
    new RegExp(`${prefix}(\\d+)_END`, 'g'),
    (token, index: string) => saved[Number(index)] ?? token,
  )
}

function captionComment(body: string, caption: string, table = false, tableId = ''): string {
  const diagram = /^ {0,3}<!--raw-typst ([\s\S]*?)-->$/.exec(body)?.[1]
  if (table) {
    const source = commentSafeString(wikiLinksToText(body))
    const label = commentSafeString(caption)
    // Every last-row cell gets a marker: a different cell can wrap farther than
    // the last short cell, so the repeat footer uses their maximum physical page.
    const marker = commentSafeString(tableId)
    return `<!--raw-typst #import "@preview/cmarker:0.1.6"; #block(breakable: true)[#show std.table: it => { let fields = it.fields(); let cells = fields.remove("children"); if cells.any(c => c.func() == std.table.footer) { it } else { let row-cells = cells.filter(c => c.func() == std.table.cell); if row-cells.len() > 0 { let final-start = cells.len() - it.columns.len(); cells = cells.enumerate().map(((index, c)) => { if c.func() == std.table.cell and index >= final-start { let cell-fields = c.fields(); let body = cell-fields.remove("body"); table.cell(..cell-fields, [#body#metadata(${marker})]) } else { c } }) } else { let header-index = cells.position(c => c.func() == std.table.header); if header-index != none { let header-fields = cells.at(header-index).fields(); let header-cells = header-fields.remove("children"); let marked-header = header-cells.map(c => { let cell-fields = c.fields(); let body = cell-fields.remove("body"); table.cell(..cell-fields, [#body#metadata(${marker})]) }); cells = cells.enumerate().map(((index, cell)) => if index == header-index { table.header(..header-fields, ..marked-header) } else { cell }) } }; let table-width = measure(it).width; std.table(..fields, ..cells, std.table.footer(repeat: true, std.table.cell(colspan: it.columns.len(), stroke: none, fill: none, context { let marker-locations = query(metadata.where(value: ${marker})); let final-page = if marker-locations.len() > 0 { calc.max(..marker-locations.map(location => counter(page).at(location.location()).first())) } else { counter(page).get().first() }; let on-final-page = counter(page).get().first() == final-page; let caption = block(width: table-width)[#align(center)[#cmarker.render(${label}, raw-typst: false, scope: (table: table))]]; if on-final-page { caption } else { block(height: measure(caption, width: table-width).height)[] } }))) } }; #cmarker.render(${source}, raw-typst: false, scope: (table: table))]-->`
  }
  const content =
    diagram === undefined
      ? `#cmarker.render(${commentSafeString(`${body}\n\n${caption}`)}, raw-typst: false)`
      : `${diagram} #cmarker.render(${commentSafeString(caption)}, raw-typst: false)`
  return `<!--raw-typst #import "@preview/cmarker:0.1.6"; #block(sticky: true)[#align(center)[${content}]]-->`
}

export async function renderPdf({
  typstBin,
  vaultRoot,
  templateDir,
  language,
  notePath,
  outPath,
  fields,
  meta,
  diagrams,
}: RenderInput): Promise<RenderResult> {
  const work = await mkdtemp(join(tmpdir(), 'holi-typst-'))
  try {
    // Preprocess the note into the work dir: wiki-links → their display text, so
    // `[[a/b.md|X]]` reads as prose rather than raw brackets in the PDF. The
    // template (its `render-body`, or Plain's inline cmarker) reads THIS copy.
    // Images go in first, as bytes resolved against the ORIGINAL note's
    // folder, before wiki-links become text, since `[[a.png]]` is an image.
    //
    // Wiki-links come out around the diagrams only: mermaid has its own `[[…]]`
    // (a subroutine shape), which must reach mermaid as written, and a drawn
    // SVG may hold `[[` in a label.
    const noteRel = relative(await realpath(vaultRoot), await realpath(notePath))
      .split(sep)
      .join('/')
    const original = await readFile(notePath, 'utf8')
    const tableFrames = readMarkdownTableCaptions(original)
    const tableFrameStarts = new Set(tableFrames.map((frame) => frame.envelope.from))
    const frames = [...readMarkdownCodeCaptions(original), ...tableFrames].sort(
      (a, b) => a.envelope.from - b.envelope.from,
    )
    // Carry each supported frame's identity in its caption through transforms.
    // The nonce is absent from the literal source, and these inline comments add
    // no lines (so source warning locations remain stable).
    let taggedOriginal = original
    let nonce = ''
    do {
      nonce = `holi-pdf-${Math.random().toString(36).slice(2)}`
    } while (original.includes(nonce))
    for (const [index, frame] of [...frames.entries()].reverse()) {
      taggedOriginal =
        taggedOriginal.slice(0, frame.caption.to) +
        ` <!-- ${nonce}-${index} -->` +
        taggedOriginal.slice(frame.caption.to)
    }
    const pictured = await inlineImages(taggedOriginal, noteRel, (rel) =>
      readVaultImage(vaultRoot, rel),
    )
    const drawn =
      diagrams === undefined
        ? {
            markdown: frames.length ? pictured.markdown : wikiLinksToText(pictured.markdown),
            warnings: [],
          }
        : await drawMermaid(
            pictured.markdown,
            diagrams,
            frames.length ? undefined : wikiLinksToText,
          )
    // Mermaid and image transforms run while the original envelopes still
    // surround their body. Then each supported element and caption becomes one
    // self-contained, non-executable-to-cmarker Typst block. The original line
    // count is retained for warnings from everything after the envelope.
    let markdown = drawn.markdown
    const transformedEnvelopes = readMarkdownCaptionEnvelopes(drawn.markdown)
    const transformations = frames.flatMap((frame, index) => {
      const identity = `<!-- ${nonce}-${index} -->`
      const transformed = transformedEnvelopes.find((item) =>
        drawn.markdown.slice(item.caption.from, item.caption.to).includes(identity),
      )
      if (transformed === undefined) return []
      const caption = original.slice(frame.caption.from, frame.caption.to)
      const sourceLines = original.slice(frame.envelope.from, frame.envelope.to).split('\n').length
      return [
        {
          frame: transformed,
          caption,
          sourceLines,
          table: tableFrameStarts.has(frame.envelope.from),
          tableId: `${nonce}-${index}`,
        },
      ]
    })
    for (const item of transformations.reverse()) {
      const body = drawn.markdown.slice(item.frame.body.from, item.frame.body.to)
      markdown =
        markdown.slice(0, item.frame.envelope.from) +
        captionComment(body, item.caption, item.table, item.tableId) +
        '\n'.repeat(Math.max(0, item.sourceLines - 1)) +
        markdown.slice(item.frame.envelope.to)
    }
    // Keep the generated caption expression (including literal code source)
    // and Mermaid drawings intact. The uncaptained wiki-link rewrite is unchanged.
    if (frames.length) markdown = wikiLinksOutsideRawTypst(markdown)
    const noteForTypst = join(work, 'note.md')
    await writeFile(noteForTypst, markdown)

    const wrapperPath = join(work, 'wrapper.typ')
    await writeFile(
      wrapperPath,
      composeWrapper({
        templateDir,
        notePath: noteForTypst,
        assetsDir: join(templateDir, 'assets'),
        fields,
        meta,
      }),
    )
    await exec(typstBin, [
      'compile',
      wrapperPath,
      outPath,
      '--root',
      '/',
      ...fontPathArgs(templateDir),
      ...(language === undefined ? [] : ['--input', `lang=${language}`]),
    ])
    const warnings = [...pictured.warnings, ...drawn.warnings]
    warnings.sort((a, b) => Number(/line (\d+)/.exec(a)?.[1]) - Number(/line (\d+)/.exec(b)?.[1]))
    return { warnings }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`typst compile failed: ${stderr}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
