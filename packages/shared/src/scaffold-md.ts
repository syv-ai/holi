/**
 * The starter frontmatter a note is born with, and the rule about which files
 * are allowed one.
 *
 * Shared because the file-tree `+` writes it at creation, and the `scaffold-md`
 * pre-commit transform writes it for every other way a `.md` lands in a vault
 * (an agent's `Write`, an import, another editor). `wantsScaffold` says where
 * frontmatter is metadata about prose, and where it is something else.
 *
 * **Only non-derivable metadata**, which leaves an empty `tags` to fill in. No
 * `created`: git's first commit for the file IS its creation, so a copy could
 * only disagree with it. No `title`: the path is the note's identity, and a
 * title field would drift from it.
 */
import { isAgentSurfacePath, isHiddenPath } from './path-safety'

/** The full file body a new note is created with. */
export function scaffoldNoteText(): string {
  return '---\ntags: []\n---\n\n'
}

/**
 * Whether a vault path is a note whose frontmatter is metadata about prose.
 *
 * Excluded, each for its own reason:
 *
 * - **The agent surface** (`isAgentSurfacePath`). These are read VERBATIM as
 *   the agent's instructions, so a `tags:` block is prompt text, not metadata
 *   (the same reason icons live in a vault-level map). A skill's frontmatter has its own schema, and
 *   `tags` is not in it.
 * - **Anything hidden**: `.holi/` and any dot-segment, which is not prose.
 * - **Non-markdown.**
 *
 * A file a plugin claims (a task) is not asked about here: its plugin owns
 * its frontmatter, so the `scaffold-md` transform skips claimed paths itself.
 *
 * A daily note needs no exclusion: it is born with `type: daily-note` and
 * `date:`, so it already has a block and the scaffold is a no-op on it.
 */
export function wantsScaffold(path: string): boolean {
  if (!path.endsWith('.md')) return false
  if (isAgentSurfacePath(path)) return false
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
