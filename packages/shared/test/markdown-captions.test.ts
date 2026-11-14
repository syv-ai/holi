import { describe, expect, it } from 'vitest'
import {
  readMarkdownCaptionEnvelopes,
  writeMarkdownCaptionEnvelope,
} from '../src/markdown-captions'

const body =
  '```mermaid\ngraph TD\nA-->B\n```\n\n![alt](image.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |'
const caption = '**A** &amp; _B_'

describe('Markdown caption envelopes', () => {
  it('round-trips opaque body Markdown and inline caption formatting', () => {
    const serialized = writeMarkdownCaptionEnvelope(body, caption)
    const [found] = readMarkdownCaptionEnvelopes(serialized)
    expect(serialized.slice(found!.body.from, found!.body.to)).toBe(body)
    expect(serialized.slice(found!.caption.from, found!.caption.to)).toBe(caption)
    expect(readMarkdownCaptionEnvelopes(serialized)).toHaveLength(1)
  })

  it('returns exact UTF-16 source ranges with CRLF and Unicode', () => {
    const source = `🙂\r\n${'<!-- holi:figure -->\r\n\r\n表\r\n\r\n<!-- holi:caption -->\r\n\r\nÉmoji 🐈\r\n\r\n<!-- /holi:figure -->'}`
    const [found] = readMarkdownCaptionEnvelopes(source)
    expect(source.slice(found!.envelope.from, found!.envelope.to)).toContain('表')
    expect(source.slice(found!.body.from, found!.body.to)).toBe('表')
    expect(source.slice(found!.caption.from, found!.caption.to)).toBe('Émoji 🐈')
    expect(found!.envelope.from).toBe('🙂\r\n'.length)
  })

  it('round-trips indented code and literal markers inside opaque body Markdown', () => {
    const bodies = [
      '```js\n    const x = 1\n```',
      '~~~mermaid extra info\ngraph TD\nA-->B\n~~~',
      '```md\n<!-- holi:figure -->\n<!-- holi:caption -->\n<!-- /holi:figure -->\n```',
      '    const x = 1',
      '    <!-- holi:figure -->',
    ]
    for (const sourceBody of bodies) {
      const serialized = writeMarkdownCaptionEnvelope(sourceBody, 'caption')
      const [found] = readMarkdownCaptionEnvelopes(serialized)
      expect(serialized.slice(found!.body.from, found!.body.to)).toBe(sourceBody)
      expect(serialized.slice(found!.caption.from, found!.caption.to)).toBe('caption')
    }
  })

  it('reads adjacent independent envelopes', () => {
    const one = writeMarkdownCaptionEnvelope('![a](a.png)', 'first')
    const two = writeMarkdownCaptionEnvelope('```js\nx\n```', 'second')
    expect(readMarkdownCaptionEnvelopes(`${one}\n\n${two}`)).toHaveLength(2)
  })

  it('does not alter or misread plain Markdown', () => {
    const plain = 'ordinary\n\n| a | b |\n| - | - |\n| x | y |'
    expect(readMarkdownCaptionEnvelopes(plain)).toEqual([])
    expect(plain).toBe('ordinary\n\n| a | b |\n| - | - |\n| x | y |')
  })

  it('ignores markers in lexical contexts and nested list or quote forms', () => {
    const source = [
      '---',
      '<!-- holi:figure -->',
      '---',
      '',
      '```md',
      '<!-- holi:figure -->',
      '```',
      '',
      '    <!-- holi:figure -->',
      '',
      '<div>',
      '<!-- holi:figure -->',
      '</div>',
      '',
      '<!-- ordinary comment',
      '<!-- holi:figure -->',
      '-->',
      '',
      '> <!-- holi:figure -->',
      '- <!-- holi:figure -->',
      '',
      writeMarkdownCaptionEnvelope('![real](x.png)', 'real'),
    ].join('\n')
    expect(readMarkdownCaptionEnvelopes(source)).toHaveLength(1)
  })

  it('leaves a complete nested envelope untouched', () => {
    const inner = writeMarkdownCaptionEnvelope('![inner](x.png)', 'inner')
    const nested = `<!-- holi:figure -->\n\nouter\n\n<!-- holi:caption -->\n\n${inner}\n\n<!-- /holi:figure -->`
    expect(readMarkdownCaptionEnvelopes(nested)).toEqual([])
  })

  it('recovers after malformed, nested and truncated framing', () => {
    const valid = writeMarkdownCaptionEnvelope('![later](x.png)', 'later')
    const source = [
      '<!-- holi:figure -->\n\nbody without caption\n\n<!-- /holi:figure -->',
      '<!-- holi:figure -->\n\nouter\n\n<!-- holi:caption -->\n\n<!-- holi:figure -->',
      '<!-- holi:figure -->\n\ntruncated',
      valid,
    ].join('\n\n')
    expect(readMarkdownCaptionEnvelopes(source)).toHaveLength(1)
  })

  it('shields marker-like lines in CommonMark HTML block contexts', () => {
    const valid = writeMarkdownCaptionEnvelope('![a](a.png)', 'caption')
    const contexts = [
      ['custom open tag until blank line', `<x-widget>\n${valid}\n</x-widget>\n\n${valid}`, 1],
      ['custom closing tag until blank line', `</x-widget>\n${valid}\n\n${valid}`, 1],
      ['type 6 block remains through inline closing tag', `<div></div>\n${valid}\n\n${valid}`, 1],
      ['type 6 block terminates at blank line', `<hr>\n\n${valid}`, 1],
      ['same-line raw closer does not extend block', `<script></script>\n${valid}`, 1],
      [
        'script ignores blank lines through closer',
        `<script>\n\n${valid}\n</script>\n\n${valid}`,
        1,
      ],
      [
        'textarea ignores blank lines through closer',
        `<textarea>\n\n${valid}\n</textarea>\n\n${valid}`,
        1,
      ],
      ['processing instruction', `<?holi\n${valid}\n?>\n\n${valid}`, 1],
      ['declaration', `<!DOCTYPE html\n${valid}\n>\n\n${valid}`, 1],
      ['CDATA', `<![CDATA[\n${valid}\n]]>\n\n${valid}`, 1],
      ['custom element ends at blank line', `<x-widget>\n${valid}\n\n${valid}`, 1],
      ['zero to three spaces before HTML', `   <x-widget>\n${valid}\n\n${valid}`, 1],
    ] as const
    for (const [name, source, count] of contexts) {
      expect(readMarkdownCaptionEnvelopes(source), name).toHaveLength(count)
    }
  })

  it('recovers valid frames after an incomplete outer candidate', () => {
    const valid = writeMarkdownCaptionEnvelope('![a](a.png)', 'caption')
    const source = `<!-- holi:figure -->\n\nincomplete\n\n${valid}\n\n${valid}`
    expect(readMarkdownCaptionEnvelopes(source)).toHaveLength(2)
  })

  it('preserves independent frames after a malformed nested frame', () => {
    const valid = writeMarkdownCaptionEnvelope('![a](a.png)', 'caption')
    expect(
      readMarkdownCaptionEnvelopes(`${valid}\n\n${valid}\n\n<!-- /holi:figure -->`),
    ).toHaveLength(2)
  })

  it('rejects content that swallows framing or block-level captions', () => {
    for (const body of ['```js\nx', '<!-- open']) {
      expect(() => writeMarkdownCaptionEnvelope(body, 'caption')).toThrow()
    }
    for (const caption of ['    code', '\tcode']) {
      expect(() => writeMarkdownCaptionEnvelope('![a](a.png)', caption)).toThrow()
    }
  })

  it('rejects empty, block, multiline and marker-colliding content', () => {
    const cases: [string, string][] = [
      ['', 'x'],
      ['x', ''],
      ['x', 'line one\nline two'],
      ['x', '# heading'],
      ['x\n\n<!-- holi:caption -->', 'caption'],
      ['<!-- holi:figure -->', 'caption'],
    ]
    for (const [element, label] of cases) {
      expect(() => writeMarkdownCaptionEnvelope(element, label)).toThrow()
    }
  })
})
