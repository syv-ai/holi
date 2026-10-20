/**
 * The page menu's Export (after ReUI's page actions): the note as HTML, as
 * plain text, and as the markdown it is. The frontmatter is the note's
 * properties, not its page, so it stays behind. Pure, for the tests.
 */
import { Marked } from 'marked'
import { frontmatterRegion } from './frontmatter-region'

/** The note without its frontmatter. */
export function noteBody(text: string): string {
  return text.slice(frontmatterRegion(text)?.to ?? 0).trim()
}

/** Holi's own syntax, in the forms other renderers read: a wiki-link as its
 *  label, `==text==` as `<mark>`, `[toc]` dropped (it draws only in Holi). */
function portable(markdown: string): string {
  return markdown
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_all, target: string, label?: string) =>
        label ?? target.replace(/\.md$/, '').split('/').pop()!,
    )
    .replace(/(^|[^=])==(?=\S)([^=\n]*?\S)==(?!=)/g, '$1<mark>$2</mark>')
    .replace(/^\[toc\]\s*$/gim, '')
}

const marked = new Marked({ gfm: true, breaks: false })

/** The note's page as HTML (GFM). */
export function noteToHtml(text: string): string {
  return (marked.parse(portable(noteBody(text)), { async: false }) as string).trim()
}

/** The note's page as plain text: each block's text, a blank line between
 *  blocks and a line per list item. */
export function noteToText(text: string): string {
  const html = noteToHtml(text)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks: string[] = []
  for (const el of Array.from(doc.body.children)) {
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      blocks.push(
        Array.from(el.querySelectorAll('li'))
          .map((li) => (li.firstChild?.textContent ?? li.textContent ?? '').trim())
          .join('\n'),
      )
    } else if (el.tagName === 'TABLE') {
      blocks.push(
        Array.from(el.querySelectorAll('tr'))
          .map((tr) =>
            Array.from(tr.children)
              .map((c) => c.textContent?.trim() ?? '')
              .join('\t'),
          )
          .join('\n'),
      )
    } else if (el.tagName !== 'HR') {
      const t = (el.textContent ?? '').trim()
      if (t !== '') blocks.push(t)
    }
  }
  return blocks.join('\n\n')
}
