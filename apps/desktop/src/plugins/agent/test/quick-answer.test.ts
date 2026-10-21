/**
 * A quick agent's answer as the panel renders it (`renderer/quick/answer.ts`):
 * Claude's markdown, made inert.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderAnswer } from '../renderer/quick/answer'

describe("the quick panel's answer", () => {
  it('renders markdown', () => {
    const html = renderAnswer(
      'The **answer** is `42`.\n\n- one\n- two\n\n[docs](https://example.com)',
    )
    expect(html).toContain('<strong>answer</strong>')
    expect(html).toContain('<code>42</code>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<a href="https://example.com">docs</a>')
  })

  it('escapes HTML, fetches nothing, and runs nothing', () => {
    const html = renderAnswer(
      '<script>alert(1)</script> <b onclick="x()">b</b>\n\n![a pixel](https://evil.example/p.gif)\n\n[run](javascript:alert(1))',
    )
    expect(html).not.toMatch(/<script|<b |<img|javascript:/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a pixel')
  })
})
