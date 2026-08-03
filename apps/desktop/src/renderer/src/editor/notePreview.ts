/**
 * The content peek behind a wiki-link hover (notes-editor PRD FR-6). Pure and
 * framework-free so it is unit-testable without a view — the CM tooltip in
 * `wikiHover.ts` renders what this returns.
 */

/** A leading YAML frontmatter block, if present. Non-greedy to the first closing
 *  `---` line; anchored at the start so it only strips a real frontmatter block. */
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/

/**
 * The title + first lines of a note's markdown. `title` is the text of a leading
 * ATX heading (the vault convention: a note opens with `# Title`), or `null` when
 * the note does not — the caller falls back to the filename. `lines` is the first
 * three non-blank body lines, trimmed, with the title line excluded.
 */
export function previewFromMarkdown(text: string): { title: string | null; lines: string[] } {
  const body = text.replace(FRONTMATTER, '')
  const nonBlank = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const heading = /^#{1,6}\s+(.+)$/.exec(nonBlank[0] ?? '')
  const title = heading ? heading[1]!.trim() : null
  const start = heading ? 1 : 0
  return { title, lines: nonBlank.slice(start, start + 3) }
}

/** The filename stem, the fallback title for a note with no leading heading. */
export function noteTitleFromPath(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.md$/, '')
}
