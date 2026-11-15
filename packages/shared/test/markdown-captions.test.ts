import { describe, expect, it } from 'vitest'
import {
  readMarkdownCaptionEnvelopes,
  readMarkdownCodeCaptions,
  writeMarkdownCaptionEnvelope,
} from '../src/markdown-captions'

const body =
  '```mermaid\ngraph TD\nA-->B\n```\n\n![alt](image.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |'
const caption = '**A** &amp; _B_'

describe('Markdown caption envelopes', () => {
  it('selects one supported code fence while preserving inline caption bytes', () => {
    const source = writeMarkdownCaptionEnvelope(
      '```mermaid\nx --> y\n```',
      '**Unicode** “quote” &amp; `--&gt;`',
    )
    const [frame] = readMarkdownCodeCaptions(source)
    expect(frame?.language).toBe('mermaid')
    expect(source.slice(frame!.caption.from, frame!.caption.to)).toBe(
      '**Unicode** “quote” &amp; `--&gt;`',
    )
  })

  it('encodes leading whitespace while preserving its portable caption range', () => {
    const serialized = writeMarkdownCaptionEnvelope('```js\nx\n```', '  name')
    expect(serialized).toContain('&#32;&#32;name')
    const [frame] = readMarkdownCodeCaptions(serialized)
    expect(frame).toBeDefined()
    expect(serialized.slice(frame!.caption.from, frame!.caption.to)).toBe('&#32;&#32;name')
  })

  it('rejects context-dependent reference definitions and reference links', () => {
    for (const caption of ['[reference]: https://example.com', '[manual][reference]', '[manual]']) {
      const source = writeMarkdownCaptionEnvelope('```js\nx\n```', caption)
      expect(readMarkdownCodeCaptions(source)).toEqual([])
    }
  })

  it('accepts inline code spans with three or more backtick delimiters', () => {
    for (const value of ['```single ` and double `` ticks```', '````two ``` and one ` ticks````']) {
      const source = writeMarkdownCaptionEnvelope('```js\nx\n```', value)
      expect(readMarkdownCodeCaptions(source)).toHaveLength(1)
    }
    expect(() => writeMarkdownCaptionEnvelope('```js\nx\n```', '```unclosed')).toThrow()
  })

  it('keeps generic framing compatible with inline code containing angle and image syntax', () => {
    expect(() => writeMarkdownCaptionEnvelope('```js\nx\n```', 'Compare `x < y`')).not.toThrow()
    expect(() => writeMarkdownCaptionEnvelope('```js\nx\n```', 'Literal `![image]`')).not.toThrow()
    expect(
      readMarkdownCodeCaptions(
        writeMarkdownCaptionEnvelope('```js\nx\n```', 'Compare `x < y` and `![image]`'),
      ),
    ).toHaveLength(1)
    expect(
      readMarkdownCodeCaptions(
        writeMarkdownCaptionEnvelope('```js\nx\n```', 'An [inline link](https://example.com)'),
      ),
    ).toHaveLength(1)
  })

  it('does not promote text after inline code into a block opener', () => {
    for (const caption of [
      '`code` # suffix',
      '`code` - suffix',
      '```single ` double `` inside``` # suffix',
    ]) {
      const source = writeMarkdownCaptionEnvelope('```js\nx\n```', caption)
      expect(readMarkdownCodeCaptions(source), caption).toHaveLength(1)
    }
  })

  it('accepts ordinary code fences of any language and no language', () => {
    for (const code of [
      '```\nx\n```',
      '```brainfuck extra\n+x\n```',
      '~~~rust\nfn main() {}\n~~~',
      '   ```js\nthree-space indent\n   ```',
    ]) {
      const source = writeMarkdownCaptionEnvelope(code, 'caption')
      expect(readMarkdownCodeCaptions(source)).toHaveLength(1)
    }
  })

  it('leaves multiple fences, prose, and unsupported envelopes opaque', () => {
    const source = [
      writeMarkdownCaptionEnvelope('```js\nx\n```\n\ntext', 'caption'),
      writeMarkdownCaptionEnvelope('```js\nx\n```\n\n```py\ny\n```', 'caption'),
      writeMarkdownCaptionEnvelope('```js\nx\n```\nprose', 'caption'),
    ].join('\n\n')
    expect(readMarkdownCodeCaptions(source)).toEqual([])
  })

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

  it('preserves Unicode separators without treating them as Markdown line breaks', () => {
    for (const separator of ['\u2028', '\u2029']) {
      expect(readMarkdownCaptionEnvelopes(`ordinary${separator}text`)).toEqual([])
      const sourceBody = `body${separator}text`
      const sourceCaption = `caption${separator}text`
      const serialized = writeMarkdownCaptionEnvelope(sourceBody, sourceCaption)
      const [found] = readMarkdownCaptionEnvelopes(serialized)
      expect(serialized.slice(found!.body.from, found!.body.to)).toBe(sourceBody)
      expect(serialized.slice(found!.caption.from, found!.caption.to)).toBe(sourceCaption)
      expect(readMarkdownCodeCaptions(serialized)).toEqual([])
      const fenced = `\`\`\`md${separator}info\n${serialized}\n\`\`\``
      expect(readMarkdownCaptionEnvelopes(fenced)).toEqual([])
    }
    expect(readMarkdownCaptionEnvelopes('ordinary\rtext')).toEqual([])
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

  it('rejects a complete nested envelope in a figure body and recovers afterwards', () => {
    const inner = writeMarkdownCaptionEnvelope('| Inner |\n| --- |\n| x |', 'inner')
    const nested = `<!-- holi:figure -->\n\nouter body\n\n${inner}\n\n<!-- holi:caption -->\n\nouter caption\n\n<!-- /holi:figure -->`
    const later = writeMarkdownCaptionEnvelope('![later](x.png)', 'later')
    const source = `${nested}\n\n${later}`
    expect(readMarkdownCaptionEnvelopes(source)).toEqual([
      expect.objectContaining({ envelope: { from: nested.length + 2, to: source.length } }),
    ])
  })

  it('rejects balanced nested regions at arbitrary depth', () => {
    const inner = writeMarkdownCaptionEnvelope('inner body', 'inner')
    const middle = `<!-- holi:figure -->\n\nmiddle body\n\n${inner}\n\n<!-- holi:caption -->\n\nmiddle caption\n\n<!-- /holi:figure -->`
    const outer = `<!-- holi:figure -->\n\nouter body\n\n${middle}\n\n<!-- holi:caption -->\n\nouter caption\n\n<!-- /holi:figure -->`
    const later = writeMarkdownCaptionEnvelope('![later](x.png)', 'later')
    expect(readMarkdownCaptionEnvelopes(`${outer}\n\n${later}`)).toHaveLength(1)
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
      [
        'closing tag with trailing text until blank line',
        `</div>trailing\n${valid}\n\n${valid}`,
        1,
      ],
      ['type 6 block remains through inline closing tag', `<div></div>\n${valid}\n\n${valid}`, 1],
      ['type 6 block terminates at blank line', `<hr>\n\n${valid}`, 1],
      ['same-line raw closer does not extend block', `<script></script>\n${valid}`, 1],
      [
        'later valid raw closer follows closer-like text',
        `<script>"</script-x>"</script>\n${valid}`,
        1,
      ],
      ['div tag name followed by newline starts a block', `<div\n${valid}`, 0],
      [
        'script tag name followed by newline shields through closer',
        `<script\n${valid}\n</script>\n\n${valid}`,
        1,
      ],
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

  it('preserves independent frames after a truncated outer frame', () => {
    const valid = writeMarkdownCaptionEnvelope('![a](a.png)', 'caption')
    const source = `<!-- holi:figure -->\n\nouter\n\n<!-- holi:caption -->\n\ntruncated\n\n${valid}\n\n${valid}`
    expect(readMarkdownCaptionEnvelopes(source)).toHaveLength(2)
  })

  it('does not let a list-local fence hide a dedented frame', () => {
    const valid = writeMarkdownCaptionEnvelope('![a](a.png)', 'caption')
    expect(readMarkdownCaptionEnvelopes('- ```js\n  code\n\n' + valid)).toHaveLength(1)
  })

  it('recognizes long malformed HTML tags without quadratic backtracking', () => {
    const source = `<x-widget ${' '.repeat(128_000)}x`
    expect(readMarkdownCaptionEnvelopes(source)).toEqual([])
  })

  it('scans many adjacent envelopes without repeated whole-input searches', () => {
    const valid = writeMarkdownCaptionEnvelope('![a](a.png)', 'caption')
    expect(readMarkdownCaptionEnvelopes(Array(16_000).fill(valid).join('\n\n'))).toHaveLength(
      16_000,
    )
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
    for (const caption of [
      '    code',
      '\tcode',
      ' \tcode',
      '  \tcode',
      '   \tcode',
      '#',
      '##',
      '_ _ _',
      '-',
      '*',
      '+',
      '1.',
    ]) {
      expect(() => writeMarkdownCaptionEnvelope('![a](a.png)', caption)).toThrow()
    }
  })

  it('does not select unsafe or non-paragraph caption syntax', () => {
    const valid = writeMarkdownCaptionEnvelope('```js\nx\n```', 'caption')
    for (const value of [
      '    indented code',
      '___',
      '-',
      '1.',
      '![image](secret.png)',
      '<div>html</div>',
      '<!--raw-typst #panic("executed")-->',
      '#',
      '## ',
      '```typst\n#panic("executed")\n```',
    ]) {
      const source = valid.replace(
        'caption\n\n<!-- /holi:figure -->',
        `${value}\n\n<!-- /holi:figure -->`,
      )
      expect(readMarkdownCodeCaptions(source)).toEqual([])
    }
  })

  it('rejects empty, block, multiline and marker-colliding content', () => {
    expect(writeMarkdownCaptionEnvelope('x', '___emphasis___')).toContain('___emphasis___')
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
