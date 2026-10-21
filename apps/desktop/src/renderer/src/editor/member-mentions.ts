/**
 * `@login` completion of the vault's people, for a comment's text
 * (docs/features/note-comments.md, Mentions). Not the notes editor's `@`,
 * which links a note: this one inserts the login that `mentionedLogins` in
 * `@holi/shared` reads back out of a comment.
 */
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { HoliCompletion } from './completion'

/** `@` and what a login can hold so far. */
const LOGIN_RE = /@[A-Za-z0-9-]*/

export function memberCompletions(
  context: CompletionContext,
  logins: readonly string[],
): CompletionResult | null {
  const match = context.matchBefore(LOGIN_RE)
  if (!match) return null
  // `ada@syv.ai` mentions nobody, the same rule `mentionedLogins` reads by.
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (/[\w@./-]/.test(before)) return null
  const query = match.text.slice(1).toLowerCase()
  const options: HoliCompletion[] = logins
    .filter((login) => login.toLowerCase().includes(query))
    .map((login) => ({ label: `@${login}`, type: 'holi-person', apply: `@${login} ` }))
  if (options.length === 0) return null
  // `from` sits at the `@`, so CodeMirror's own filter would see it; the list
  // is already filtered.
  return { from: match.from, options, filter: false }
}

/** The CodeMirror source: reads the people live on each `@`. */
export function memberMentionSource(logins: () => readonly string[]): CompletionSource {
  return (context) => memberCompletions(context, logins())
}
