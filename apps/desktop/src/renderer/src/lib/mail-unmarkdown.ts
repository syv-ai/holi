/**
 * HTML → markdown.
 *
 * 1. Opening a draft Holi did not write: the composer edits markdown, so there
 *    is never a read-only draft. `X-Holi-Source` only buys a byte-exact round
 *    trip.
 * 2. Quoting a parent that exists only as HTML, keeping tables as tables.
 *
 * Sanitise before converting: `turndown` builds a DOM from its input.
 * `allowRemoteContent` because nothing here renders or fetches.
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
 * Tables and strikethrough. The plugin emits a table with no heading row as raw
 * markup; `unwrapLayoutTables` removes those first.
 */
turndown.use(gfm)

/**
 * `~~`, not the plugin's single `~`.
 *
 * A single tilde is the looser GFM form, and the draft's `text/plain` part may
 * be read by any client.
 */
turndown.addRule('strikethrough', {
  filter: ['del', 's'],
  replacement: (content) => `~~${content}~~`,
})

/**
 * Is this table holding DATA, or is it holding a layout?
 *
 * Mail layouts are nested spacer tables with no heading row, and
 * `turndown-plugin-gfm` emits any table without a heading row as raw markup.
 *
 * At least as strict as the plugin's own test (`every(TH)`): unwrapping a data
 * table costs prose, but letting a layout table through puts raw markup in
 * front of the user.
 */
function isDataTable(table: HTMLTableElement): boolean {
  const first = table.rows[0]
  if (first === undefined || first.cells.length === 0) return false
  return [...first.cells].every((cell) => cell.nodeName === 'TH')
}

/**
 * Layout tables out, their content kept, before `turndown` ever sees them.
 *
 * A DOM pass, not a turndown rule: the plugin converts `<td>`/`<tr>`
 * unconditionally, so a `TABLE` rule would receive pipe syntax already.
 *
 * Every cell becomes its own block, so neighbouring columns never join. Runs
 * already-sanitised markup.
 */
function unwrapLayoutTables(root: HTMLElement): void {
  // Outer-first is fine: unwrapping MOVES nested tables, so they stay
  // connected for their turn.
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
 * Trimmed, blank-line runs collapsed (newsletters produce dozens), and no
 * trailing whitespace.
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
 * A blank line becomes a bare `>` (no trailing whitespace); empty input quotes
 * to `''`, not a lone `>`.
 */
export function quoteAsMarkdown(text: string): string {
  if (text === '') return ''
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}
