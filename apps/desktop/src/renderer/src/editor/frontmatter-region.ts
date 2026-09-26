/**
 * The pure decisions behind the frontmatter widget.
 *
 * Text-based, not tree-based: GFM's Lezer grammar has no frontmatter node.
 * `frontmatterYamlValid` reuses the shared `splitFrontmatter`, so the widget
 * never disagrees with what the task and daily-note parsers accept.
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
 * The same block as a decoration range: `frontmatterRegion` minus its trailing
 * newline. The one character is load-bearing: a block `Decoration.replace`
 * must end at a line END. Ending at `region.to` (the next line's start) gives
 * the first body position to the widget's row, and the caret renders on the
 * widget at its full height.
 *
 * Parsing and write-back keep the newline, or every keystroke would leave a
 * stray blank line.
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
 * Does the document's frontmatter parse as YAML? `true` with no fence; `false`
 * on a parse error or an unterminated fence. The save gate holds off while false.
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
