import { describe, expect, it } from 'vitest'
import { renderNote } from '../src/main/capabilities/render-note'

describe('renderNote', () => {
  it('renders markdown', () => {
    expect(renderNote('# Plan\n\n- **one**\n')).toContain('<strong>one</strong>')
  })

  it('escapes inline HTML, so a note cannot run script in the app', () => {
    const html = renderNote('hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('turns a wiki-link into an anchor Holi opens, attribute and text escaped', () => {
    expect(renderNote('see [[notes/a b.md|the "plan"]]')).toContain(
      '<a href="#" data-holi-open="notes/a b.md">the &quot;plan&quot;</a>',
    )
    expect(renderNote('see [[x" onclick="y]]')).toContain(
      'data-holi-open="x&quot; onclick=&quot;y"',
    )
  })

  it('keeps web links and drops a javascript: one to its text', () => {
    expect(renderNote('[site](https://example.com)')).toContain('href="https://example.com"')
    const html = renderNote('[click](javascript:alert(1))')
    expect(html).not.toContain('href')
    expect(html).toContain('click')
  })

  it('leaves a wiki-link in code as code', () => {
    expect(renderNote('`[[a]]`')).not.toContain('data-holi-open')
  })

  it('reads an image or an embed as its text', () => {
    expect(renderNote('![a cat](cat.png) ![[pic.png]]')).not.toMatch(/<img|data-holi-open/)
  })

  it('drops frontmatter', () => {
    expect(renderNote('---\ntitle: x\n---\n\nbody\n')).not.toContain('title')
  })
})
