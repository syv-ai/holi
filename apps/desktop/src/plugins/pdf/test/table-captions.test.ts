import { describe, expect, it } from 'vitest'
import { writeMarkdownCaptionEnvelope } from '@holi/shared'
import { readMarkdownTableCaptions } from '../main/table-captions'

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

  it('accepts Markdown reference links for document-wide resolution', () => {
    const source = writeMarkdownCaptionEnvelope('| A |\n| --- |\n| [ref][label] |', 'Caption')
    expect(readMarkdownTableCaptions(source)).toHaveLength(1)
  })

  it('rejects a nested table envelope without selecting its inner frame', () => {
    const inner = writeMarkdownCaptionEnvelope('| Inner |\n| --- |\n| x |', 'inner')
    const outer = `<!-- holi:figure -->\n\nouter body\n\n${inner}\n\n<!-- holi:caption -->\n\nouter caption\n\n<!-- /holi:figure -->`
    expect(readMarkdownTableCaptions(outer)).toEqual([])
  })
})
