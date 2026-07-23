/**
 * The two pure decisions behind the frontmatter widget (FR-2 hide / FR-16 reveal).
 *
 * **Text-based, not tree-based, on purpose.** GFM's Lezer grammar has no YAML
 * frontmatter node — the leading `---…---` is just paragraphs and thematic
 * breaks to it — so the widget's region is found the same way the parsers find
 * it: by scanning the text. `frontmatterYamlValid` reuses the shared
 * `splitFrontmatter`, so the status dot can never disagree with what the task
 * and daily-note parsers will actually accept.
 */
import { splitFrontmatter } from '@holi/shared'
import { parse as parseYaml } from 'yaml'

/**
 * The character range `[from, to)` of the leading fence block — from offset 0
 * through the newline after the closing `---` — or `null` when the document
 * does not open with a terminated fence. The `\n---` / next-newline scan mirrors
 * `splitFrontmatter` so hide and parse agree on where the block ends.
 *
 * Assumes `\n` line endings (CodeMirror normalizes to them on document load).
 */
export function frontmatterRegion(doc: string): { from: number; to: number } | null {
  if (!doc.startsWith('---\n')) return null
  const end = doc.indexOf('\n---', 3)
  if (end === -1) return null
  const afterFence = doc.indexOf('\n', end + 1)
  return { from: 0, to: afterFence === -1 ? doc.length : afterFence + 1 }
}

/**
 * The same block, as a **decoration** range: `frontmatterRegion` minus its
 * trailing newline.
 *
 * The two differ by exactly one character and the difference is load-bearing. A
 * `Decoration.replace({block: true})` is meant to cover whole lines — start at a
 * line start, end at a line *end*. Ending it at `region.to` instead ends it at
 * the start of the following line, so the first body position belongs to the
 * widget's row: the caret rendered on the frontmatter, right-most in it, and
 * grew to the widget's height when the block was revealed. Clamping the caret to
 * `region.to` could not help, because `region.to` was the wrong side of the
 * boundary.
 *
 * Parsing and write-back keep the newline — `regionTextFrom` reconstructs it and
 * `writeBack` replaces `[region.from, region.to]`, so a region that stopped
 * short would leave a stray blank line behind on every keystroke. Only what
 * CodeMirror is asked to *replace* drops it.
 */
export function frontmatterBlockRange(doc: string): { from: number; to: number } | null {
  const region = frontmatterRegion(doc)
  if (region === null) return null
  // The one case with no newline to drop: the fence runs to the end of the
  // document, so its line end already IS `to`.
  const to = doc[region.to - 1] === '\n' ? region.to - 1 : region.to
  return { from: region.from, to }
}

/**
 * Does the document's frontmatter parse as YAML? `true` when there is no fence
 * (nothing to be invalid) or the YAML parses; `false` on a parse throw or an
 * unterminated fence (which `splitFrontmatter` throws on). This is the exact
 * gate the downstream parsers apply — the save gate holds off while it is false.
 */
export function frontmatterYamlValid(doc: string): boolean {
  try {
    const { yaml } = splitFrontmatter(doc)
    if (yaml === null) return true
    parseYaml(yaml)
    return true
  } catch {
    return false
  }
}
