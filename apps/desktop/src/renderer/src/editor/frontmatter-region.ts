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
