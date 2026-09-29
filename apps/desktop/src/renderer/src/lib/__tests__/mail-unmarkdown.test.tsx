/**
 * HTML → markdown.
 *
 * Two callers: opening a draft Holi did not write, and quoting an HTML-only
 * parent. Both are third-party markup, so the sanitiser runs before `turndown`,
 * which builds a DOM from its input.
 */
import { describe, expect, it } from 'vitest'
import { renderMailMarkdown } from '../mail-markdown'
import { mailHtmlToMarkdown, quoteAsMarkdown } from '../mail-unmarkdown'

describe('mailHtmlToMarkdown', () => {
  it('round-trips the ordinary marks', () => {
    expect(mailHtmlToMarkdown('<p><strong>bold</strong></p>')).toBe('**bold**')
    expect(mailHtmlToMarkdown('<p><em>italic</em></p>')).toBe('_italic_')
    expect(mailHtmlToMarkdown('<h1>Heading</h1>')).toBe('# Heading')
  })

  it('keeps a link as a link, with its address', () => {
    const markdown = mailHtmlToMarkdown('<p>see <a href="https://syv.ai">the site</a></p>')

    expect(markdown).toBe('see [the site](https://syv.ai)')
  })

  it('keeps a table as a markdown table', () => {
    // Without the GFM rules a table flattens to prose.
    const markdown = mailHtmlToMarkdown(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )

    expect(markdown).toContain('| a | b |')
    expect(markdown).toContain('| 1 | 2 |')
    expect(markdown).toMatch(/\| *-+ *\|/)
  })

  /**
   * A layout table is not a data table. `turndown-plugin-gfm` keeps any table
   * without a heading row as raw markup, and mail layouts have none. The
   * fixture is the real shape: nested, `role="presentation"`, inline styles.
   */
  it('unwraps a layout table instead of emitting its markup', () => {
    const markdown = mailHtmlToMarkdown(
      '<table role="presentation" cellpadding="0"><tbody><tr><td style="padding:20px">' +
        '<table role="presentation"><tbody><tr><td><p>the actual message</p></td></tr></tbody></table>' +
        '</td></tr></tbody></table>',
    )

    expect(markdown).not.toContain('<table')
    expect(markdown).not.toContain('cellpadding')
    expect(markdown).toContain('the actual message')
  })

  /**
   * A real MJML mail, trimmed but not simplified, so the regression is pinned
   * to real markup: sibling section tables, four levels of
   * `role="presentation"` nesting, `font-size:0px` spacers, a button `<a>` in a
   * `bgcolor` cell, a two-column footer, and no `<th>` anywhere.
   */
  it('converts a real MJML newsletter to prose, not markup', () => {
    const mjml =
      '<table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" ' +
      'style="width:100%;"><tbody><tr><td ' +
      'style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;"><div ' +
      'class="mj-column-per-100 mj-outlook-group-fix" ' +
      'style="font-size:0px;display:inline-block;width:100%;"><table border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody><tr><td ' +
      'align="center" style="font-size:0px;padding:10px 25px;word-break:break-word;"><table ' +
      'border="0" cellpadding="0" cellspacing="0" role="presentation" ' +
      'style="border-collapse:collapse;"><tbody><tr><td style="width:112px;"><img alt="Claude" ' +
      'src="https://claude.test/logo.png" width="112" height="33"></td></tr></tbody></table>' +
      '</td></tr></tbody></table></div></td></tr></table><table align="center" border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" style="width:100%;"><tbody><tr><td ' +
      'style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;"><div ' +
      'class="mj-column-per-100 mj-outlook-group-fix" ' +
      'style="font-size:0px;display:inline-block;width:100%;"><table border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody><tr><td ' +
      'align="center" style="font-size:0px;padding:10px 25px;word-break:break-word;"><div ' +
      'style="font-size: 28px; font-weight: bold; color: #141413;">Sign in to Claude.ai</div>' +
      '</td></tr><tr><td align="center" ' +
      'style="font-size:0px;padding:10px 25px;word-break:break-word;"><div ' +
      'style="font-size: 18px; color: #141413;">Click the button below to finish signing ' +
      'in.</div></td></tr><tr><td align="center" class="layout-btn" ' +
      'style="font-size:0px;padding:10px 25px;word-break:break-word;"><table border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;">' +
      '<tbody><tr><td align="center" bgcolor="#141413" role="presentation" ' +
      'style="border-radius:10px;background:#141413;" valign="middle"><p ' +
      'style="display: inline-block; background: #141413; color: #ffffff; margin: 0;"><a ' +
      'href="https://claude.test/magic-link" style="color: white; padding: 14px 36px;">Sign ' +
      'in</a></p></td></tr></tbody></table></td></tr></tbody></table></div></td></tr></table>' +
      '<table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" ' +
      'style="width:100%;"><tbody><tr><td ' +
      'style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;"><div ' +
      'class="mj-column-per-65 mj-outlook-group-fix" ' +
      'style="font-size:0px;display:inline-block;width:100%;"><table border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody><tr><td ' +
      'align="left" style="font-size:0px;padding:10px 25px;word-break:break-word;"><div ' +
      'style="font-size:14px;color:#7B7974;">Anthropic, PBC</div></td></tr></tbody></table>' +
      '</div><div class="mj-column-per-35 mj-outlook-group-fix" ' +
      'style="font-size:0px;display:inline-block;width:100%;"><table border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody><tr><td ' +
      'align="right" style="font-size:0px;padding:10px 25px;word-break:break-word;"><table ' +
      'align="right" border="0" cellpadding="0" cellspacing="0" role="presentation" ' +
      'style="display:inline-table;"><tbody><tr><td style="padding:0 6px;"><table border="0" ' +
      'cellpadding="0" cellspacing="0" role="presentation" style="width:20px;"><tbody><tr><td ' +
      'style="font-size:0;height:20px;width:20px;"><a href="https://social.test/x"><img alt="" ' +
      'height="20" src="https://claude.test/x.png" width="20"></a></td></tr></tbody></table>' +
      '</td></tr></tbody></table></td></tr></tbody></table></div></td></tr></table>'

    const markdown = mailHtmlToMarkdown(mjml)

    // Not one byte of the layout survives as markup.
    expect(markdown).not.toContain('<table')
    expect(markdown).not.toContain('cellpadding')
    expect(markdown).not.toContain('role="presentation"')
    expect(markdown).not.toContain('mj-column')
    // The message does.
    expect(markdown).toContain('Sign in to Claude.ai')
    expect(markdown).toContain('Click the button below to finish signing in.')
    expect(markdown).toContain('[Sign in](https://claude.test/magic-link)')
    expect(markdown).toContain('Anthropic, PBC')
    // The two footer columns are separate blocks, not one line.
    expect(markdown).not.toMatch(/Anthropic, PBC[^\n]*!\[/)
  })

  it('keeps the cells of a layout table as separate blocks', () => {
    // Unwrapping must not join two cells into one line.
    const markdown = mailHtmlToMarkdown(
      '<table><tbody><tr><td>left</td><td>right</td></tr>' +
        '<tr><td>second row</td><td>and its neighbour</td></tr></tbody></table>',
    )

    expect(markdown).not.toContain('<table')
    expect(markdown).toContain('left')
    expect(markdown).toContain('right')
    expect(markdown).not.toMatch(/leftright/)
  })

  it('keeps strikethrough', () => {
    expect(mailHtmlToMarkdown('<p><del>gone</del></p>')).toBe('~~gone~~')
  })

  it('keeps a nested list nested', () => {
    const markdown = mailHtmlToMarkdown('<ul><li>one<ul><li>one a</li></ul></li><li>two</li></ul>')

    // The indent width is turndown's business; that nesting survives is ours.
    expect(markdown).toMatch(/^- +one$/m)
    expect(markdown).toMatch(/^ {2,}- +one a$/m)
    expect(markdown).toMatch(/^- +two$/m)
  })

  it('drops a script before the converter ever sees it', () => {
    // Sanitised first: `turndown` would otherwise parse this.
    const markdown = mailHtmlToMarkdown('<p>hi</p><script>steal()</script>')

    expect(markdown).toBe('hi')
    expect(markdown).not.toContain('steal')
  })

  it('drops a form, which is the exfiltration shape', () => {
    const markdown = mailHtmlToMarkdown(
      '<form action="https://evil.example"><input name="password"></form><p>hi</p>',
    )

    expect(markdown).toBe('hi')
  })

  it('collapses long runs of blank lines', () => {
    // Newsletter HTML produces dozens.
    const markdown = mailHtmlToMarkdown('<p>one</p><br><br><br><br><br><p>two</p>')

    expect(markdown).not.toMatch(/\n{3,}/)
  })

  it('leaves no trailing whitespace on any line', () => {
    const markdown = mailHtmlToMarkdown('<p>one </p><p>two</p>')

    for (const line of markdown.split('\n')) expect(line).toBe(line.replace(/\s+$/, ''))
  })

  it('converts an empty document to an empty string', () => {
    expect(mailHtmlToMarkdown('')).toBe('')
    expect(mailHtmlToMarkdown('   ')).toBe('')
  })
})

describe('the round trip', () => {
  /**
   * The round trip: a foreign draft is converted here, then rendered by
   * `renderMailMarkdown` for preview and send, so both halves must agree.
   */
  it.each([
    ['bold', '<p><strong>bold</strong></p>', '<strong>bold</strong>'],
    ['italic', '<p><em>italic</em></p>', '<em>italic</em>'],
    ['strikethrough', '<p><del>gone</del></p>', '<del>gone</del>'],
    ['a link', '<p><a href="https://syv.ai">site</a></p>', 'href="https://syv.ai"'],
    ['a heading', '<h2>Heading</h2>', 'Heading</h2>'],
  ])('survives html → markdown → html for %s', (_name, html, expected) => {
    expect(renderMailMarkdown(mailHtmlToMarkdown(html))).toContain(expected)
  })

  /**
   * Drafts: the higher stakes, since a bad unwrap eats something the user is
   * about to send, and Gmail drafts arrive full of layout tables.
   */
  it('leaves a foreign draft editable rather than full of markup', () => {
    const draft =
      '<div><table role="presentation"><tbody><tr><td>' +
      '<p>Hi Bo — <strong>the numbers</strong> are below.</p>' +
      '</td></tr></tbody></table></div>'

    const markdown = mailHtmlToMarkdown(draft)

    expect(markdown).not.toContain('<table')
    expect(markdown).toContain('**the numbers**')
    expect(renderMailMarkdown(markdown)).toContain('<strong>the numbers</strong>')
  })

  it('survives for a table, which is the one that used to flatten', () => {
    const html =
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'

    const back = renderMailMarkdown(mailHtmlToMarkdown(html))

    expect(back).toContain('<table>')
    expect(back).toContain('<th>a</th>')
    expect(back).toContain('<td>2</td>')
  })
})

describe('quoteAsMarkdown', () => {
  it('prefixes every line', () => {
    expect(quoteAsMarkdown('one\ntwo')).toBe('> one\n> two')
  })

  it('quotes a blank line as a bare marker, with no trailing space', () => {
    // Trailing whitespace is a diff nuisance and some clients render it.
    expect(quoteAsMarkdown('one\n\ntwo')).toBe('> one\n>\n> two')
  })

  it('quotes an empty string as an empty string, not as a lone marker', () => {
    // A parent with no body produces no empty quote block.
    expect(quoteAsMarkdown('')).toBe('')
  })

  it('nests an already-quoted line rather than flattening it', () => {
    expect(quoteAsMarkdown('> earlier')).toBe('> > earlier')
  })
})
