/**
 * HTML → markdown (D71).
 *
 * Two callers, and they are the reason this file exists: opening a draft Holi
 * did not write, and quoting a parent that only ever existed as HTML. Both are
 * third-party markup arriving from a mailbox, which is why the sanitiser runs
 * *before* the converter rather than after — `turndown` builds a DOM from the
 * string it is given, so handing it raw newsletter HTML means parsing untrusted
 * markup with the app's own parser.
 *
 * This is the file that makes "no read-only state ever" true. Every failure
 * here shows up as a message the user can look at but not edit.
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
    // The wart this task exists to remove. Without the GFM rules a table
    // flattens to a run of prose and the quoted message becomes unreadable.
    const markdown = mailHtmlToMarkdown(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )

    expect(markdown).toContain('| a | b |')
    expect(markdown).toContain('| 1 | 2 |')
    expect(markdown).toMatch(/\| *-+ *\|/)
  })

  /**
   * A LAYOUT table is not a data table, and mail is built almost entirely out of
   * the first kind.
   *
   * `turndown-plugin-gfm` converts a table only when its first row is a heading
   * row, and calls `turndown.keep()` on every other one — so an MJML newsletter,
   * which nests borderless spacer tables several deep and has never heard of
   * `<th>`, came through the reply quote as raw `<table>` markup. The user saw
   * three screens of `cellpadding="0"` where the message should have been.
   *
   * The fixture is the shape that actually arrives: nested, `role="presentation"`,
   * inline styles, no heading row anywhere.
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
   * The email that actually did it, trimmed but not simplified.
   *
   * The hand-built fixture above is the *shape*; this is the thing itself — an
   * MJML build (Claude.ai's sign-in mail), which is what a real inbox is full
   * of. Every property that made the bug possible is kept: sibling section
   * tables at the top level, four levels of `role="presentation"` nesting,
   * `font-size:0px` spacer cells, a button that is an `<a>` inside a `<p>`
   * inside a `bgcolor` cell, a two-column footer, and — the whole reason the
   * plugin's fallback fired — no `<th>` anywhere in the document.
   *
   * A reply sent from the build between `0f57f6f` and `2b3098f` put this
   * message's raw markup into the mail as text, starting `<table align="center"
   * border="0" cellpadding="0"`, which is what the recipient received. The
   * synthetic fixture would not have caught it any better than it did; what
   * this adds is that the regression is now pinned to real markup rather than
   * to markup written by someone who already knew the answer.
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
    // The two footer columns are separate blocks. `\s*` would be wrong here —
    // the blank line between them IS the separation; what must not happen is
    // the two ending up on one line.
    expect(markdown).not.toMatch(/Anthropic, PBC[^\n]*!\[/)
  })

  it('keeps the cells of a layout table as separate blocks', () => {
    // Unwrapping must not run two unrelated cells together into one line —
    // a two-column layout is two things, not one sentence.
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
    const markdown = mailHtmlToMarkdown(
      '<ul><li>one<ul><li>one a</li></ul></li><li>two</li></ul>',
    )

    // The exact indent width is turndown's business; that the nesting survives
    // at all is this module's.
    expect(markdown).toMatch(/^- +one$/m)
    expect(markdown).toMatch(/^ {2,}- +one a$/m)
    expect(markdown).toMatch(/^- +two$/m)
  })

  it('drops a script before the converter ever sees it', () => {
    // Sanitised first, not after. `turndown` would otherwise parse this.
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
    // Newsletter HTML produces dozens, and they push the reply box off screen.
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
   * The pair, not either half. A foreign draft is converted by this module and
   * then rendered by `renderMailMarkdown` for the preview and for sending — so
   * a mark that survives conversion but not the re-render still reaches the
   * recipient as plain text, and the user never sees it happen.
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
   * The second caller, and the one with the higher stakes.
   *
   * A quote that unwraps badly is ugly. A *draft* that unwraps badly has eaten
   * something the user wrote and is about to send — and a Gmail-composed draft
   * is exactly the case that arrives full of layout tables.
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
    // A parent with no body must not produce a quote block containing nothing,
    // which reads as a rendering bug directly above the user's cursor.
    expect(quoteAsMarkdown('')).toBe('')
  })

  it('nests an already-quoted line rather than flattening it', () => {
    expect(quoteAsMarkdown('> earlier')).toBe('> > earlier')
  })
})
