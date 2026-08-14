/**
 * HTML → markdown (D71).
 *
 * Two callers, and they are the reason this exists:
 *
 * 1. **Opening a draft Holi did not write.** The composer's source of truth is
 *    markdown, so a draft written in Gmail — or by anything else — has to
 *    become markdown before it can be edited. This is what makes "no read-only
 *    state ever" true, and it is why `X-Holi-Source` is an optimisation rather
 *    than a gate: the marker buys a byte-exact round trip, and its absence
 *    costs a good conversion, not an editing surface.
 * 2. **Quoting a parent that only exists as HTML.** A quoted table stays a
 *    table, which `bodyTextOf` could not manage.
 *
 * **Sanitise before converting, not after.** `turndown` builds a DOM from the
 * string it is handed, so feeding it a mailbox's raw markup means parsing
 * untrusted HTML with the app's own parser. `allowRemoteContent` is passed
 * because nothing here renders — no image is ever fetched from this path, so
 * blocking would only strip `src` attributes out of the markdown for no gain.
 */
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { sanitizeMailHtml } from './mail-html'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  // `_` rather than `*` for emphasis, so a quoted `*` in prose does not read as
  // an unclosed mark when the two end up on the same line.
  emDelimiter: '_',
  bulletListMarker: '-',
})

// Tables and strikethrough. Without these a quoted table flattens into a run of
// prose, which is the wart this module was added to remove.
turndown.use(gfm)

/**
 * `~~`, not the plugin's single `~`.
 *
 * Both parse back to `<del>` in marked, so the round trip survives either way —
 * but a single tilde is the looser of the two GFM forms and not every consumer
 * of this markdown is marked. The draft is written to Gmail as the `text/plain`
 * part, where the reader may be any client at all.
 */
turndown.addRule('strikethrough', {
  filter: ['del', 's'],
  replacement: (content) => `~~${content}~~`,
})

/**
 * Convert a mail's HTML to markdown the composer can edit.
 *
 * The output is trimmed and normalised: runs of three or more blank lines
 * collapse to one (newsletter HTML produces dozens, and they push the reply box
 * off screen), and no line keeps trailing whitespace — it is a diff nuisance
 * and some clients render it.
 */
export function mailHtmlToMarkdown(html: string): string {
  const safe = sanitizeMailHtml(html, { allowRemoteContent: true })
  return turndown
    .turndown(safe.html)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Quote text as a markdown blockquote.
 *
 * A blank line becomes a bare `>` rather than `> `, because trailing whitespace
 * is a diff nuisance and some clients render it. An empty input quotes to an
 * empty string rather than a lone `>`, which would read as a rendering bug
 * directly above the user's cursor on a parent that had no body.
 */
export function quoteAsMarkdown(text: string): string {
  if (text === '') return ''
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}
