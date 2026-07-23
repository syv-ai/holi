/**
 * Starter frontmatter for a hand-created note.
 *
 * Only **non-derivable** metadata: `created` (git's first-commit date is not
 * surfaced in-app) and an empty `tags` to fill in. Deliberately no `title` — the
 * filename already is the note's identity (paths are what wiki-links and renames
 * operate on), so a title field would just duplicate it and drift the moment
 * either side changes. Daily notes and tasks scaffold their own shapes elsewhere;
 * this is only the plain "new note" path (the file-tree `+`).
 *
 * Pure and date-injected so it is testable without a clock.
 */

/** The full file body a new note is created with. `isoDate` is `YYYY-MM-DD`. */
export function scaffoldNoteText(isoDate: string): string {
  return `---\ncreated: ${isoDate}\ntags: []\n---\n\n`
}
