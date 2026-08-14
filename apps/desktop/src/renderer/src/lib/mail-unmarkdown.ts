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

/**
 * Tables and strikethrough. Without these a quoted DATA table flattens into a
 * run of prose, which is the wart this module was added to remove.
 *
 * The plugin covers only half the problem, and the half it leaves is worse than
 * the one it fixes: a table with no heading row is `keep()`-ed, meaning its raw
 * markup is emitted verbatim. See `unwrapLayoutTables`, which removes those
 * before the converter runs.
 */
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
 * Is this table holding DATA, or is it holding a layout?
 *
 * Mail is built out of the second kind — MJML and every newsletter builder
 * before it nest borderless spacer tables several deep, because that is the only
 * layout primitive mail clients have agreed on in thirty years. None of them has
 * a heading row.
 *
 * This matters because `turndown-plugin-gfm` converts a table **only** when its
 * first row is a heading row, and calls `turndown.keep()` on every other one —
 * meaning it emits the raw `<table>` markup. Quoting a newsletter therefore
 * produced screens of `cellpadding="0"` where the message should have been.
 *
 * **Deliberately stricter than the plugin's own `isHeadingRow`.** The two tests
 * have to agree about which tables the plugin will convert, and disagreement in
 * one direction is harmless (a data table gets unwrapped into prose) while
 * disagreement in the other puts raw markup back in front of the user. So the
 * bar here is the plugin's `every(TH)` condition and nothing softer: anything
 * this calls a layout table is a table the plugin would certainly have kept.
 */
function isDataTable(table: HTMLTableElement): boolean {
  const first = table.rows[0]
  if (first === undefined || first.cells.length === 0) return false
  return [...first.cells].every((cell) => cell.nodeName === 'TH')
}

/**
 * Layout tables out, their content kept, before `turndown` ever sees them.
 *
 * Done as a DOM pass rather than as a turndown rule, and the reason is the cell
 * rules: the GFM plugin converts `<td>` and `<tr>` *unconditionally*, so
 * overriding only the `TABLE` rule would hand the replacement a body that had
 * already been rendered into `| pipe | syntax |`. Overriding all three means
 * re-deriving the plugin's private heading-row test inside turndown's rule
 * pipeline. Removing the tables first is one pass with nothing to keep in sync.
 *
 * **Every cell becomes its own block.** A two-column layout is two things, and
 * running them together would silently join a caption to the paragraph beside
 * it. The blank blocks that spacer cells leave behind are collapsed by the
 * newline pass in `mailHtmlToMarkdown`.
 *
 * The markup is already sanitised when this runs, so building a DOM from it is
 * not a second exposure — see the module note on ordering.
 */
function unwrapLayoutTables(root: HTMLElement): void {
  // Static list, and outer-first is fine: unwrapping an outer table MOVES its
  // nested tables into the replacement rather than detaching them, so they are
  // still connected when their turn comes.
  for (const table of root.querySelectorAll('table')) {
    if (isDataTable(table)) continue
    const replacement = root.ownerDocument.createElement('div')
    for (const row of table.rows) {
      for (const cell of row.cells) {
        const block = root.ownerDocument.createElement('div')
        block.append(...cell.childNodes)
        replacement.append(block)
      }
    }
    table.replaceWith(replacement)
  }
}

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
  const host = document.createElement('div')
  host.innerHTML = safe.html
  unwrapLayoutTables(host)
  return turndown
    .turndown(host.innerHTML)
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
