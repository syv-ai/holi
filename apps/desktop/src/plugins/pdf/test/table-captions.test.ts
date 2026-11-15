import { describe, expect, it } from 'vitest'
import { writeMarkdownCaptionEnvelope } from '@holi/shared'
import { readMarkdownReferenceDefinitions, readMarkdownTableCaptions } from '../main/table-captions'

describe('readMarkdownReferenceDefinitions', () => {
  it('keeps complete parsed definitions and excludes code, HTML, and malformed fences', () => {
    const source = [
      '[link]: https://example.com/one',
      '  "continued title"',
      '',
      '````markdown',
      '[fenced]: https://ignored.invalid/',
      '```',
      '[still-fenced]: https://ignored.invalid/',
      '````',
      '',
      '    [indented]: https://ignored.invalid/',
      '',
      '<div>',
      '[html]: https://ignored.invalid/',
      '</div>',
      '',
      '> [quoted]: https://example.com/quoted',
      '',
      '[second]: https://example.com/two',
    ].join('\n')
    expect(readMarkdownReferenceDefinitions(source)).toBe(
      '\n\n[link]: https://example.com/one "continued title"\n[quoted]: https://example.com/quoted\n[second]: https://example.com/two',
    )
  })
})

describe('reference definition normalization', () => {
  it('excludes frontmatter and keeps Markdown reference destinations', () => {
    const source = [
      '---',
      'description: |',
      '',
      '  [ref]: https://wrong.example/',
      '---',
      '',
      writeMarkdownCaptionEnvelope('| A |\n| --- |\n| [ref] |', 'Caption.'),
      '',
      '[ref]: https://right.example/',
    ].join('\n')
    expect(readMarkdownReferenceDefinitions(source)).toContain('[ref]: https://right.example/')
    expect(readMarkdownReferenceDefinitions(source)).not.toContain('wrong.example')
  })

  it('preserves non-ASCII separators in labels and escaped angle destinations', () => {
    const source = String.raw`[a b]: https://example.com/
[ref]: <https://example.com/a\>b>`
    const definitions = readMarkdownReferenceDefinitions(source)
    expect(definitions).toContain('[a b]: https://example.com/')
    expect(definitions).toContain('<https://example.com/a\\>b>')
  })

  it('parses escaped-angle definitions in context and preserves first-definition precedence', () => {
    const captioned = (link: string) =>
      writeMarkdownCaptionEnvelope(`| A |\n| --- |\n| ${link} |`, 'Edge caption.')
    const fenced =
      captioned('[code]') + '\n\n```markdown\n[code]: <https://example.com/hidden\\>a>\n```\n'
    expect(readMarkdownReferenceDefinitions(fenced)).toBe('')

    const first = String.raw`[ref]: <https://example.com/first\>a>`
    const duplicate = `${first}\n\n${captioned('[ref]')}\n\n[ref]: https://example.com/second\n`
    expect(readMarkdownReferenceDefinitions(duplicate)).toBe(
      `\n\n${first}\n[ref]: https://example.com/second`,
    )

    const quoted = captioned('[ref]') + '\n\n> [ref]: <https://example.com/quoted\\>a>\n'
    expect(readMarkdownReferenceDefinitions(quoted)).toContain(
      String.raw`[ref]: <https://example.com/quoted\>a>`,
    )

    const list = captioned('[ref]') + '\n\n- [ref]: <https://example.com/list\\>a>\n'
    expect(readMarkdownReferenceDefinitions(list)).toContain(
      String.raw`[ref]: <https://example.com/list\>a>`,
    )
  })

  it('does not reinterpret an unescaped closing angle after paired backslashes', () => {
    expect(readMarkdownReferenceDefinitions(String.raw`[ref]: <https://example.com/a\\>b>`)).toBe(
      '',
    )
  })

  it('does not extract escaped-angle definitions from HTML or indented code', () => {
    const source = [
      '<div>',
      String.raw`[html]: <https://example.com/html\>a>`,
      '</div>',
      '',
      '<!--',
      String.raw`[comment]: <https://example.com/comment\>a>`,
      '-->',
      '',
      String.raw`    [indented]: <https://example.com/code\>a>`,
    ].join('\n')
    expect(readMarkdownReferenceDefinitions(source)).toBe('')
  })

  it('removes container markers, preserves escapes, and keeps duplicate source order', () => {
    const source = String.raw`> [target]:
>   https://example.org/destination
>
> > [multi
> > line]: <https://example.org/a\(b> "title
> > with \"quotes\""

- [escaped\]label]:
    https://example.org/escaped\(path\) 'list title'

[target]: https://ignored.invalid/duplicate
`
    expect(readMarkdownReferenceDefinitions(source)).toBe(
      String.raw`

[target]: https://example.org/destination
[multi line]: <https://example.org/a\(b> "title with \"quotes\""
[escaped\]label]: https://example.org/escaped\(path\) 'list title'
[target]: https://ignored.invalid/duplicate`,
    )
  })
})

describe('readMarkdownTableCaptions', () => {
  it('accepts one self-contained GFM table and portable caption', () => {
    const source = writeMarkdownCaptionEnvelope(
      '| Name | Value |\n|:---|---:|\n| `a|b` &amp; [site](https://example.com) | [[note.md|wiki]] |',
      '**Caption** with _emphasis_.',
    )
    expect(readMarkdownTableCaptions(source)).toHaveLength(1)
  })

  it.each([
    '| Name |\n| --- |\n| <b>raw</b> |',
    '| Name |\n| --- |\n| [^note] |',
    '| Name |\n| --- |\n| value |\n\nMore prose',
    '| Name |\n| --- |\n| value |\n\n| Other |\n| --- |\n| table |',
  ])('leaves unsupported or ambiguous body in ordinary Markdown: %s', (body) => {
    const source = writeMarkdownCaptionEnvelope(body, 'Caption')
    expect(readMarkdownTableCaptions(source)).toEqual([])
  })

  it('accepts unaliased and aliased text wiki-links', () => {
    for (const link of ['[[notes/plan.md]]', '[[notes/plan.md|Plan]]']) {
      const source = writeMarkdownCaptionEnvelope(`| A |\n| --- |\n| ${link} |`, 'Caption')
      expect(readMarkdownTableCaptions(source)).toHaveLength(1)
    }
  })

  it('preserves wiki-image syntax inside code cells', () => {
    const source = writeMarkdownCaptionEnvelope(
      '| Example |\n| --- |\n| `[[dot.png|photo]]` |',
      'Caption',
    )
    expect(readMarkdownTableCaptions(source)).toHaveLength(1)
  })

  it('rejects a caption with document-wide references', () => {
    const source = writeMarkdownCaptionEnvelope('| A |\n| --- |\n| x |', '[ref][label]')
    expect(readMarkdownTableCaptions(source)).toEqual([])
  })

  it('accepts inline and reference images for the PDF image adapter', () => {
    for (const image of ['![photo](x.png)', '![photo][image]']) {
      const source = writeMarkdownCaptionEnvelope(`| A |\n| --- |\n| ${image} |`, 'Caption')
      expect(readMarkdownTableCaptions(source)).toHaveLength(1)
    }
  })

  it.each(['[ref][label]', '[ref][]', '[label]'])('accepts reference link forms: %s', (link) => {
    const source = writeMarkdownCaptionEnvelope(`| A |\n| --- |\n| ${link} |`, 'Caption')
    expect(readMarkdownTableCaptions(source)).toHaveLength(1)
  })

  it('keeps HTML, footnotes, and unsupported table content lossless', () => {
    for (const cell of ['<!--raw-typst #panic("bad")-->', '[^note]', '[@cite]', '<span>x</span>']) {
      const source = writeMarkdownCaptionEnvelope(`| A |\n| --- |\n| ${cell} |`, 'Caption')
      expect(readMarkdownTableCaptions(source)).toEqual([])
    }
  })

  it('rejects a nested table envelope without selecting its inner frame', () => {
    const inner = writeMarkdownCaptionEnvelope('| Inner |\n| --- |\n| x |', 'inner')
    const outer = `<!-- holi:figure -->\n\nouter body\n\n${inner}\n\n<!-- holi:caption -->\n\nouter caption\n\n<!-- /holi:figure -->`
    expect(readMarkdownTableCaptions(outer)).toEqual([])
  })
})
