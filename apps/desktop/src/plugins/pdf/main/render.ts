import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type TemplateField, wikiLinksToText } from '@holi/shared'
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
  /** Absolute `.holi/document-templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note. */
  notePath: string
  /** Absolute `.pdf` destination. */
  outPath: string
  /** The template's declared fields — drives meta coercion in the wrapper. */
  fields: TemplateField[]
  meta: Record<string, string>
}

/**
 * Compose a wrapper in a fresh temp dir and run `typst compile`, producing
 * `outPath`. `--root /` because the wrapper (temp dir), the template, and the
 * note live in three different trees and the wrapper references them all by
 * absolute path — no single narrower root spans them. Throws with typst's
 * stderr on a non-zero exit. `--font-path` is added (via `fontPathArgs`) when the
 * template has a seeded `_brand/fonts` sibling — the branded templates' Raleway.
 */
export async function renderPdf({
  typstBin,
  templateDir,
  notePath,
  outPath,
  fields,
  meta,
}: RenderInput): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'holi-typst-'))
  try {
    // Preprocess the note into the work dir: wiki-links → their display text, so
    // `[[a/b.md|X]]` reads as prose rather than raw brackets in the PDF. The
    // template (its `render-body`, or Plain's inline cmarker) reads THIS copy.
    // cmarker already resolves note-relative images against its own package dir,
    // not the note dir, so moving the note regresses nothing; if that is fixed
    // later, the image base must be the ORIGINAL note dir (dirname(notePath)).
    const noteForTypst = join(work, 'note.md')
    await writeFile(noteForTypst, wikiLinksToText(await readFile(notePath, 'utf8')))

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
    await exec(typstBin, ['compile', wrapperPath, outPath, '--root', '/', ...fontPathArgs(templateDir)])
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`typst compile failed: ${stderr}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
