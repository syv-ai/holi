/**
 * Markdown → HTML, the renderer's half of the composer.
 *
 * Markdown is the only authoring language: inline HTML is escaped, so
 * `value < 5` survives and a web paste cannot smuggle markup. The authoring
 * boundary, not the security one; `dompurify` still runs downstream.
 */
import { describe, expect, it } from 'vitest'
import { renderMailMarkdown } from '../renderer/mail-markdown'

describe('renderMailMarkdown', () => {
  it('renders the ordinary marks', () => {
    expect(renderMailMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMailMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMailMarkdown('# Heading')).toMatch(/<h1[^>]*>Heading<\/h1>/)
  })

  it('renders a GFM table as a table', () => {
    // A quoted table must not flatten to prose.
    const html = renderMailMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')

    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('renders the rest of GFM — strikethrough, task lists, autolinks', () => {
    expect(renderMailMarkdown('~~gone~~')).toContain('<del>gone</del>')
    expect(renderMailMarkdown('- [x] done')).toContain('type="checkbox"')
    expect(renderMailMarkdown('mail ada@syv.ai today')).toContain('href="mailto:ada@syv.ai"')
  })

  it('escapes a block-level HTML tag rather than emitting it', () => {
    const html = renderMailMarkdown('<div>hi</div>')

    expect(html).toContain('&lt;div&gt;')
    expect(html).not.toContain('<div>')
  })

  it('escapes inline HTML too', () => {
    // Block and inline HTML are separate token types through one hook. Asserted
    // against the DOM: an escaped tag still contains `onclick` as inert text.
    const host = document.createElement('div')
    host.innerHTML = renderMailMarkdown('a <span onclick="x()">word</span> here')

    expect(host.querySelector('span')).toBeNull()
    expect(host.textContent).toContain('<span onclick="x()">word</span>')
  })

  it('leaves a less-than that was never a tag alone', () => {
    // `value < 5` must neither become markup nor vanish.
    const html = renderMailMarkdown('if value < 5 then stop')

    expect(html).toContain('value &lt; 5')
  })

  it('keeps a fenced code block verbatim', () => {
    const html = renderMailMarkdown('```\nconst a = 1 < 2\n```')

    expect(html).toContain('<pre>')
    expect(html).toContain('const a = 1 &lt; 2')
  })

  it('does not turn a single newline into a line break', () => {
    // `breaks` stays off, or soft wraps sprout <br>s.
    const html = renderMailMarkdown('one\ntwo')

    expect(html).not.toContain('<br')
    expect(html).toContain('one\ntwo')
  })

  it('separates paragraphs on a blank line', () => {
    const html = renderMailMarkdown('one\n\ntwo')

    expect(html).toContain('<p>one</p>')
    expect(html).toContain('<p>two</p>')
  })

  it('renders an empty document as an empty string', () => {
    // An empty message is allowed to send, and `buildRfc822` relies on
    // this returning '' rather than a stray empty paragraph.
    expect(renderMailMarkdown('')).toBe('')
  })

  it('is pure — the same input renders the same bytes twice', () => {
    // `marked.use` mutates a global other modules could configure.
    const markdown = '**bold** and `code`'

    expect(renderMailMarkdown(markdown)).toBe(renderMailMarkdown(markdown))
  })
})
