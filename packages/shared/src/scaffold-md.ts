/**
 * The starter frontmatter a note is born with, and the rule about which files
 * are allowed one.
 *
 * Shared because **three** places have to agree on it. The file-tree `+` writes
 * it at creation; the `scaffold-md` pre-commit transform writes it for every
 * other way a `.md` lands in a vault — an agent's `Write`, a drag-and-drop
 * import, a file made in another editor — and both have to mean the same four
 * lines. The third is `wantsScaffold`, which is the interesting one: it says
 * where frontmatter is metadata about prose, and where it is something else.
 *
 * **Only non-derivable metadata**, which leaves an empty `tags` to fill in. No
 * `created`: git's first commit for the file IS its creation, and the editor
 * shows it as read-only metadata, so a hand-editable copy in the file could
 * only ever disagree with it. Deliberately no `title` —
 * the filename already is the note's identity, since paths are what wiki-links
 * and renames operate on, so a title field would duplicate it and drift the
 * moment either side changed.
 */
import { isAgentSurfacePath, isHiddenPath } from './path-safety'
import { isTaskFilePath } from './task-file'

/** The full file body a new note is created with. */
export function scaffoldNoteText(): string {
  return '---\ntags: []\n---\n\n'
}

/**
 * Whether a vault path is a note whose frontmatter is metadata about prose.
 *
 * Four kinds of markdown are excluded, and each for its own reason rather than
 * as a blanket "system files":
 *
 * - **The agent surface** (`CLAUDE.md`, `AGENTS.md`, `MEMORY.md`,
 *   `USER.local.md`, everything under `.claude/`). These are read VERBATIM as
 *   the agent's instructions, so a `tags:` block at the top is not metadata,
 *   it is prompt text. D82 already established this when it refused to put a
 *   note's icon in frontmatter for the same reason. A skill's frontmatter is a
 *   typed interface with a schema of its own, and `tags` is not in it.
 * - **Task files.** `serializeTaskFile` owns their frontmatter completely and
 *   `normalize-md` already rewrites it into canonical order; a second writer
 *   with its own idea of the shape would fight it every commit.
 * - **Anything hidden** — `.holi/`, and any dot-segment. That is Holi's own
 *   config and the vault apps, none of which is prose.
 * - **Non-markdown**, which `createNoteAtom` had already decided.
 *
 * A daily note needs no exclusion: it is born with `type: daily-note` and
 * `date:`, so it already has a block and the scaffold is a no-op on it.
 */
export function wantsScaffold(path: string): boolean {
  if (!path.endsWith('.md')) return false
  if (isAgentSurfacePath(path)) return false
  if (isTaskFilePath(path)) return false
  if (isHiddenPath(path)) return false
  return true
}

/** Whether a file already opens with a frontmatter fence.
 *
 *  A `---` with no closing fence counts as YES. The file is mid-edit and trying
 *  to be frontmatter; prepending a second block would bury the one being typed. */
export function hasFrontmatter(text: string): boolean {
  return text.replace(/\r\n/g, '\n').startsWith('---\n')
}

/**
 * `text` with the starter block on top, or `text` unchanged when it already has
 * frontmatter. Idempotent by that check alone, which is what lets the transform
 * run on every commit.
 */
export function scaffoldFrontmatter(text: string): string {
  return hasFrontmatter(text) ? text : scaffoldNoteText() + text
}
