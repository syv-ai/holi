/**
 * Starter frontmatter for a hand-created note.
 *
 * New notes open with `title` + `created` frontmatter so the frontmatter widget
 * has something to show and metadata is there from the start rather than bolted
 * on later. Daily notes and tasks scaffold their own shapes elsewhere — this is
 * only the plain "new note" path (the file-tree `+`).
 *
 * Pure and date-injected so it is testable without a clock.
 */

/** `meeting-notes.md` → `Meeting notes`. The filename is the one thing we know
 *  about a brand-new note, so it seeds the title; the user overwrites it. */
export function humanizeTitle(path: string): string {
  const base = (path.split('/').at(-1) ?? path).replace(/\.md$/i, '')
  const spaced = base.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The full file body a new note is created with. `isoDate` is `YYYY-MM-DD`. */
export function scaffoldNoteText(path: string, isoDate: string): string {
  return `---\ntitle: ${humanizeTitle(path)}\ncreated: ${isoDate}\n---\n\n`
}
