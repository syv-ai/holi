import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { composeWrapper } from './wrapper'

const exec = promisify(execFile)

export interface RenderInput {
  /** Absolute path to the typst binary (from resolveTypstBin/ensureTypst). */
  typstBin: string
  /** Absolute `.holi/templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note. */
  notePath: string
  /** Absolute `.pdf` destination. */
  outPath: string
  meta: Record<string, string>
}

/**
 * Compose a wrapper in a fresh temp dir and run `typst compile`, producing
 * `outPath`. `--root /` because the wrapper (temp dir), the template, and the
 * note live in three different trees and the wrapper references them all by
 * absolute path — no single narrower root spans them. Throws with typst's
 * stderr on a non-zero exit. Fonts (`--font-path`) are a later concern; Plain
 * ships none.
 */
export async function renderPdf({
  typstBin,
  templateDir,
  notePath,
  outPath,
  meta,
}: RenderInput): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'holi-typst-'))
  try {
    const wrapperPath = join(work, 'wrapper.typ')
    await writeFile(
      wrapperPath,
      composeWrapper({ templateDir, notePath, assetsDir: join(templateDir, 'assets'), meta }),
    )
    await exec(typstBin, ['compile', wrapperPath, outPath, '--root', '/'])
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`typst compile failed: ${stderr}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
