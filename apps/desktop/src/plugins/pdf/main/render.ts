import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { isMachineStatePath, isSecretPath, wikiLinksToText } from '@holi/shared'
import { resolveRelative } from '@holi/shared/path-safety-node'
import type { TemplateField } from '../shared/template-fields'
import { inlineImages } from './images'
import { drawMermaid, type DrawDiagrams } from './mermaid'
import { composeWrapper } from './wrapper'

const exec = promisify(execFile)

/**
 * `--font-path` args for a template, or `[]`. The branded templates (proposal,
 * report) render with Raleway, which the seeded `_brand/fonts` sibling holds;
 * `plain` ships none and a vault not yet re-seeded has no `_brand` at all, so
 * this is guarded on existence — a missing dir would make typst error rather
 * than fall back to its defaults.
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
export async function renderPdf({
  typstBin,
  vaultRoot,
  templateDir,
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
    const pictured = await inlineImages(await readFile(notePath, 'utf8'), noteRel, (rel) =>
      readVaultImage(vaultRoot, rel),
    )
    const drawn =
      diagrams === undefined
        ? { markdown: wikiLinksToText(pictured.markdown), warnings: [] }
        : await drawMermaid(pictured.markdown, diagrams, wikiLinksToText)
    const noteForTypst = join(work, 'note.md')
    await writeFile(noteForTypst, drawn.markdown)

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
    ])
    return { warnings: [...pictured.warnings, ...drawn.warnings] }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`typst compile failed: ${stderr}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
