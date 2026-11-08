/** A `.test.tsx` so it runs in the jsdom project: links are clicked in a real document. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn()
vi.mock('@/plugin-api', () => ({ openExternal: (url: string) => openExternal(url) }))
const { followLink } = await import('../renderer/inert-frame')

/** A document holding `body`, with `followLink` listening as a frame would. */
function page(body: string, onInternal?: (href: string) => void): Document {
  const doc = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><body>${body}</body></html>`,
    'application/xhtml+xml',
  )
  doc.addEventListener('click', (event) => followLink(event, onInternal))
  return doc
}

function click(doc: Document, selector: string): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  doc.querySelector(selector)!.dispatchEvent(event)
  return event
}

describe('a link in a file', () => {
  beforeEach(() => openExternal.mockReset())

  it('opens a web or mail link in the browser and never navigates the frame', () => {
    const doc = page(
      '<a id="a" href="https://example.com/a"><span id="in">x</span></a><a id="m" href="mailto:ada@syv.ai">m</a>',
    )
    expect(click(doc, '#in').defaultPrevented).toBe(true)
    expect(click(doc, '#m').defaultPrevented).toBe(true)
    expect(openExternal.mock.calls).toEqual([['https://example.com/a'], ['mailto:ada@syv.ai']])
  })

  it('hands a link within the file to the caller', () => {
    const internal = vi.fn()
    const doc = page(
      '<a id="b" href="#chapter-2">b</a><a id="c" href="text/ch3.xhtml#p1">c</a>',
      internal,
    )
    click(doc, '#b')
    click(doc, '#c')
    expect(internal.mock.calls).toEqual([['#chapter-2'], ['text/ch3.xhtml#p1']])
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does nothing with a script, file or data link', () => {
    const internal = vi.fn()
    const doc = page(
      [
        'javascript:alert(1)',
        ' JavaScript:x',
        'file:///etc/passwd',
        'data:text/html,x',
        'vbscript:x',
      ]
        .map((href, i) => `<a id="l${i}" href="${href.replace(/&/g, '&amp;')}">x</a>`)
        .join(''),
      internal,
    )
    for (let i = 0; i < 5; i++) expect(click(doc, `#l${i}`).defaultPrevented).toBe(true)
    expect(internal).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('leaves a click off any link alone', () => {
    const doc = page('<p id="p">text</p>')
    expect(click(doc, '#p').defaultPrevented).toBe(false)
  })

  it('takes an SVG xlink:href and an image map area too', () => {
    const doc =
      page(`<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="https://x.example/svg"><rect id="r" width="1" height="1"/></a></svg>
      <map name="m"><area id="area" href="https://x.example/area" shape="rect" coords="0,0,1,1"/></map>`)
    expect(click(doc, '#r').defaultPrevented).toBe(true)
    expect(click(doc, '#area').defaultPrevented).toBe(true)
    expect(openExternal.mock.calls).toEqual([['https://x.example/svg'], ['https://x.example/area']])
  })
})
