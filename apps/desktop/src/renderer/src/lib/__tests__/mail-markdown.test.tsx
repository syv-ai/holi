/**
 * Markdown → HTML, the renderer's half of the composer (D71).
 *
 * The decision this file guards is that **markdown is the only authoring
 * language**. Inline HTML is escaped rather than passed through, which buys
 * three things at once: the `text/plain` part stays a message a human can read,
 * `value < 5` survives being typed, and a paste from a web page cannot smuggle
 * markup into a mail the user believes they wrote by hand.
 *
 * `dompurify` still runs downstream — this is not the security boundary, it is
 * the authoring one. The two are separate and both are load-bearing.
 */
import { describe, expect, it } from 'vitest'
import { renderMailMarkdown } from '../mail-markdown'

describe('renderMailMarkdown', () => {
  it('renders the ordinary marks', () => {
    expect(renderMailMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMailMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMailMarkdown('# Heading')).toMatch(/<h1[^>]*>Heading<\/h1>/)
  })

  it('renders a GFM table as a table', () => {
    // The wart this exists to remove: a quoted table flattening to prose.
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
    // marked 18 routes block and inline HTML through the same `html` hook, but
    // they are separate token types and only one of them is the obvious case.
    //
    // Asserted against the DOM rather than the string: an escaped tag still
    // *contains* the characters `onclick`, as inert text the reader sees. Only
    // parsing can tell markup that runs from text that reads like markup.
    const host = document.createElement('div')
    host.innerHTML = renderMailMarkdown('a <span onclick="x()">word</span> here')

    expect(host.querySelector('span')).toBeNull()
    expect(host.textContent).toContain('<span onclick="x()">word</span>')
  })

  it('leaves a less-than that was never a tag alone', () => {
    // Typing `value < 5` in a mail is not markup and must not become one, nor
    // vanish. This is the case a naive `stripTags` gets wrong.
    const html = renderMailMarkdown('if value < 5 then stop')

    expect(html).toContain('value &lt; 5')
  })

  it('keeps a fenced code block verbatim', () => {
    const html = renderMailMarkdown('```\nconst a = 1 < 2\n```')

    expect(html).toContain('<pre>')
    expect(html).toContain('const a = 1 &lt; 2')
  })

  it('does not turn a single newline into a line break', () => {
    // `breaks` stays off. Mail written in an editor with soft wrapping would
    // otherwise sprout a <br> at every wrap point the author never typed.
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
    // An empty message is allowed to send (D71), and `buildRfc822` relies on
    // this returning '' rather than a stray empty paragraph.
    expect(renderMailMarkdown('')).toBe('')
  })

  it('is pure — the same input renders the same bytes twice', () => {
    // `marked.use` mutates a global. Using it would make this module's output
    // depend on whatever else in the app had configured marked first.
    const markdown = '**bold** and `code`'

    expect(renderMailMarkdown(markdown)).toBe(renderMailMarkdown(markdown))
  })
})
