/**
 * The mail sanitizer — the one place in Holi that turns attacker-controlled
 * input into markup.
 *
 * Every test here is an attack or a leak, not a formatting preference. A message
 * body is written by whoever felt like emailing the user, so the interesting
 * cases are the ones where the output *looks* fine and quietly does something:
 * a pixel that reports the mail was opened, a `<style>` block that restyles the
 * app around it, a form that posts somewhere on click.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeMailHtml } from '../mail-html'

/** Parse the result so assertions ask about the DOM, not about string spelling
 *  — `src=""` vs no attribute is a serialisation detail, not a behaviour. */
function parse(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

/** Every `on*` attribute left anywhere in the output. The safety property is
 *  "nothing can fire", which is not the same as "the element is gone". */
function handlerAttributes(html: string): string[] {
  return [...parse(html).querySelectorAll('*')].flatMap((element) =>
    [...element.attributes].map((a) => a.name).filter((name) => name.startsWith('on')),
  )
}

describe('sanitizeMailHtml — script execution', () => {
  it('removes a script element and its contents', () => {
    const { html } = sanitizeMailHtml('<p>hi</p><script>alert(1)</script>')

    expect(html).toContain('hi')
    expect(html).not.toContain('alert')
    expect(parse(html).querySelector('script')).toBeNull()
  })

  it('removes event-handler attributes', () => {
    const { html } = sanitizeMailHtml('<img src="data:," onerror="alert(1)"><b onclick="x()">b</b>')

    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onclick')
    expect(parse(html).querySelector('b')?.textContent).toBe('b')
  })

  it('drops a javascript: href but keeps the link text', () => {
    const { html } = sanitizeMailHtml('<a href="javascript:alert(1)">click me</a>')

    expect(html).not.toContain('javascript:')
    expect(parse(html).textContent).toContain('click me')
  })

  it('survives the mXSS shapes that defeat regex strippers', () => {
    // A naive `<[^>]+>` stripper leaves something live behind in both of these.
    // What survives here is inert: escaped text in the first, and in the second
    // an <img> with neither a handler nor a source. Assert that, not absence —
    // "the element is gone" is a stronger claim than safety actually needs.
    const nested = sanitizeMailHtml('<scr<script>ipt>alert(1)</scr</script>ipt>')
    const svg = sanitizeMailHtml('<svg><style><img src=x onerror=alert(1)></style></svg>')

    expect(parse(nested.html).querySelector('script')).toBeNull()
    expect(handlerAttributes(nested.html)).toEqual([])
    expect(handlerAttributes(svg.html)).toEqual([])
    expect(parse(svg.html).querySelector('img')?.hasAttribute('src')).toBe(false)
  })
})

describe('sanitizeMailHtml — embedding and exfiltration', () => {
  it('removes iframes, objects and embeds', () => {
    const { html } = sanitizeMailHtml(
      '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="y">',
    )
    const dom = parse(html)

    expect(dom.querySelector('iframe')).toBeNull()
    expect(dom.querySelector('object')).toBeNull()
    expect(dom.querySelector('embed')).toBeNull()
  })

  it('removes forms — a mail body must not be able to post anywhere', () => {
    const { html } = sanitizeMailHtml(
      '<form action="https://evil.test"><input name="p"><button>Go</button></form>',
    )
    const dom = parse(html)

    expect(dom.querySelector('form')).toBeNull()
    expect(dom.querySelector('input')).toBeNull()
  })

  it('removes <base>, which would silently retarget every relative link', () => {
    expect(parse(sanitizeMailHtml('<base href="https://evil.test/">').html).querySelector('base'))
      .toBeNull()
  })
})

describe('sanitizeMailHtml — styling', () => {
  it('keeps <style> out of the markup, and hands the sheet over separately', () => {
    // Why the tag stays forbidden: DOMPurify strips stylesheet contents as an
    // mXSS mitigation, and forcing them back changes how it *parses* — measured,
    // on the payload in the mXSS test above, which stops being neutralised.
    //
    // What changed is that this no longer costs the newsletter its design. The
    // sheet is lifted from the raw markup before sanitizing and travels in `css`,
    // so DOMPurify's input is untouched and the frame still gets the stylesheet.
    // Both halves are asserted here, because the value of this design is exactly
    // that they hold at the same time.
    const { html, css } = sanitizeMailHtml('<style>body{display:none}</style><p>hi</p>')

    expect(html).not.toContain('display:none')
    expect(parse(html).querySelector('style')).toBeNull()
    expect(parse(html).textContent).toBe('hi')
    expect(css).toBe('body{display:none}')
  })

  it('keeps inline styles — that is how designed mail is actually built', () => {
    const { html } = sanitizeMailHtml('<p style="color:#c00;font-weight:bold">warning</p>')

    expect(parse(html).querySelector('p')?.getAttribute('style')).toContain('color')
  })
})

describe('sanitizeMailHtml — remote content', () => {
  it('blocks a remote image and reports it, so the open is not reported back', () => {
    const result = sanitizeMailHtml('<p>hi</p><img src="https://tracker.test/pixel.gif" alt="">')

    expect(result.blockedRemoteCount).toBe(1)
    expect(result.html).not.toContain('tracker.test')
    // The element stays — removing it would reflow designed mail into nonsense.
    expect(parse(result.html).querySelector('img')?.hasAttribute('src')).toBe(false)
  })

  it('blocks protocol-relative and http sources too', () => {
    expect(sanitizeMailHtml('<img src="//tracker.test/a.gif">').blockedRemoteCount).toBe(1)
    expect(sanitizeMailHtml('<img src="http://tracker.test/a.gif">').blockedRemoteCount).toBe(1)
  })

  it('blocks a remote background-image hidden in an inline style', () => {
    const result = sanitizeMailHtml(
      '<div style="background-image:url(https://tracker.test/p.png);color:red">x</div>',
    )

    expect(result.blockedRemoteCount).toBe(1)
    expect(result.html).not.toContain('tracker.test')
    // Only the fetching declaration goes; the rest of the styling survives.
    expect(parse(result.html).querySelector('div')?.getAttribute('style')).toContain('red')
  })

  it('blocks srcset and poster, which are image loads by another name', () => {
    const srcset = sanitizeMailHtml('<img srcset="https://tracker.test/2x.gif 2x">')
    const poster = sanitizeMailHtml('<video poster="https://tracker.test/p.jpg"></video>')

    expect(srcset.html).not.toContain('tracker.test')
    expect(poster.html).not.toContain('tracker.test')
  })

  it('keeps a data: image — nothing is fetched, so nothing is disclosed', () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    const result = sanitizeMailHtml(`<img src="${src}">`)

    expect(result.blockedRemoteCount).toBe(0)
    expect(parse(result.html).querySelector('img')?.getAttribute('src')).toBe(src)
  })

  it('leaves a stylesheet no route to fetch, now that the stylesheet survives', () => {
    // `@import` and `url()` inside a <style> are remote fetches no attribute
    // pass can see. Once the sheet is carried into the frame instead of dropped,
    // "nothing scrubs them because nothing has to" stops being true — the frame's
    // `default-src 'none'` is still the backstop, but it is no longer the only
    // thing standing there.
    const result = sanitizeMailHtml(
      '<style>@import "https://tracker.test/x.css";p{background:url(https://tracker.test/p.png)}</style>',
    )

    expect(result.html).not.toContain('tracker.test')
    expect(result.css).not.toContain('tracker.test')
    expect(result.css).not.toContain('@import')
  })

  /**
   * The stylesheet is carried, not dropped — and this is the case it exists for.
   *
   * MJML puts column widths in a `min-width` media query and leaves the inline
   * width at 100%, which is its *mobile* fallback. With the sheet gone, every
   * multi-column newsletter rendered permanently stacked: a two-column footer
   * became two rows, and a product grid became one tall column.
   */
  it('carries the stylesheet that holds a column layout', () => {
    const result = sanitizeMailHtml(
      '<style>@media only screen and (min-width:480px){' +
        '.mj-column-per-65{width:65%!important}.mj-column-per-35{width:35%!important}}</style>' +
        '<div class="mj-column-per-65" style="width:100%">left</div>',
    )

    expect(result.css).toContain('min-width:480px')
    expect(result.css).toContain('.mj-column-per-65{width:65%!important}')
    // And it is still not in the markup — see the mXSS reasoning above.
    expect(parse(result.html).querySelector('style')).toBeNull()
    expect(result.html).not.toContain('65%')
  })

  it('joins several stylesheets in the order the message declared them', () => {
    const result = sanitizeMailHtml(
      '<style>p{color:red}</style><p>x</p><style>p{color:blue}</style>',
    )

    expect(result.css.indexOf('red')).toBeLessThan(result.css.indexOf('blue'))
  })

  it('counts and strips a remote image the stylesheet asks for, like an inline one', () => {
    const result = sanitizeMailHtml(
      '<style>.hero{background:url(https://tracker.test/p.png);color:red}</style>',
    )

    // Same promise as the inline-style pass: the declaration goes, its
    // neighbours stay, and the count is what makes the banner honest.
    expect(result.css).not.toContain('tracker.test')
    expect(result.css).toContain('color:red')
    expect(result.blockedRemoteCount).toBe(1)
  })

  it('leaves the stylesheet’s remote images alone once the user has loaded them', () => {
    const result = sanitizeMailHtml(
      '<style>.hero{background:url(https://cdn.test/p.png)}</style>',
      { allowRemoteContent: true },
    )

    expect(result.css).toContain('cdn.test')
    expect(result.blockedRemoteCount).toBe(0)
  })

  it('does not count a data: url in the stylesheet', () => {
    const result = sanitizeMailHtml(
      '<style>.hero{background:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)}</style>',
    )

    expect(result.css).toContain('data:image')
    expect(result.blockedRemoteCount).toBe(0)
  })

  it('leaves a data: url in CSS alone, and does not count it', () => {
    // The count drives a banner that says the sender would have been told the
    // mail was opened. A data: url tells nobody anything, so counting it here
    // would put a false statement in front of the user.
    const result = sanitizeMailHtml(
      '<div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">x</div>',
    )

    expect(result.blockedRemoteCount).toBe(0)
    expect(parse(result.html).querySelector('div')?.getAttribute('style')).toContain('data:image')
  })

  it('loads remote content when the user asks for it', () => {
    const result = sanitizeMailHtml('<img src="https://cdn.test/logo.png">', {
      allowRemoteContent: true,
    })

    expect(result.blockedRemoteCount).toBe(0)
    expect(parse(result.html).querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.test/logo.png',
    )
  })

  it('still refuses scripts when remote content is allowed', () => {
    // "Load images" is a content decision, never a safety one.
    const result = sanitizeMailHtml('<script>alert(1)</script><img src="https://cdn.test/a.png">', {
      allowRemoteContent: true,
    })

    expect(result.html).not.toContain('alert')
  })
})

describe('sanitizeMailHtml — links', () => {
  it('keeps an http link but strips target, so the app decides where it opens', () => {
    const { html } = sanitizeMailHtml('<a href="https://syv.ai" target="_blank">syv</a>')
    const anchor = parse(html).querySelector('a')

    expect(anchor?.getAttribute('href')).toBe('https://syv.ai')
    expect(anchor?.hasAttribute('target')).toBe(false)
  })

  it('keeps a mailto: link', () => {
    expect(parse(sanitizeMailHtml('<a href="mailto:a@b.c">mail</a>').html).querySelector('a')
      ?.getAttribute('href')).toBe('mailto:a@b.c')
  })
})

describe('sanitizeMailHtml — ordinary mail', () => {
  it('leaves the markup a real message is made of alone', () => {
    const { html } = sanitizeMailHtml(
      '<div><h1>Q2</h1><p>Hi <b>Ada</b>,</p><ul><li>one</li></ul>' +
        '<table><tr><td>cell</td></tr></table><blockquote>quoted</blockquote></div>',
    )
    const dom = parse(html)

    for (const tag of ['h1', 'p', 'b', 'ul', 'li', 'table', 'td', 'blockquote']) {
      expect(dom.querySelector(tag), tag).not.toBeNull()
    }
  })

  it('is empty for an empty body rather than throwing', () => {
    expect(sanitizeMailHtml('')).toEqual({ html: '', css: '', blockedRemoteCount: 0 })
  })
})
