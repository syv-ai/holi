import { describe, expect, it } from 'vitest'
import { inlineImages } from '../main/images'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const jpg = new Uint8Array([0xff, 0xd8, 0xff])
const bytesOf = (b: Uint8Array): string => [...b].join(',')

/** Inline with a loader that hands `bytes` for every path, recording them. */
async function inline(markdown: string, notePath = 'note.md', bytes = png) {
  const asked: string[] = []
  const result = await inlineImages(markdown, notePath, async (p) => (asked.push(p), bytes))
  return { ...result, asked }
}

describe('inlineImages', () => {
  it('puts a relative image in as bytes, resolved against the note’s folder', async () => {
    const { markdown, warnings, asked } = await inline(
      'Se ![Kort](../figurer/kort%20a.png "titel") her.',
      'kunder/acme/rapport.md',
    )
    expect(asked).toEqual(['kunder/figurer/kort a.png'])
    expect(markdown).toBe(
      `Se <!--raw-typst #image(bytes((${bytesOf(png)})), format: "png", alt: "Kort")--> her.`,
    )
    expect(warnings).toEqual([])
  })

  it('reads every image CommonMark sees, and only those', async () => {
    const note = [
      '![a [b] c](x.png) ![p](foo(1).png) ![s](<a b.png>) ![r][ref] ![Ref][] ![ref] ![nope][none]',
      '',
      '    ![indented](code.png)',
      '',
      '<!-- ![commented](c.png) -->',
      '',
      '`![span](s.png)`',
      '',
      '```',
      '![fenced](f.png)',
      '```',
      '',
      '[ref]: r.png',
    ].join('\n')
    const { markdown, asked } = await inline(note)
    expect(asked).toEqual(['x.png', 'foo(1).png', 'a b.png', 'r.png', 'r.png', 'r.png'])
    expect(markdown).toContain('alt: "a [b] c"')
    expect(markdown).toContain('![nope][none]')
    for (const kept of ['code.png', 'c.png', '`![span](s.png)`', 'f.png']) {
      expect(markdown).toContain(kept)
    }
  })

  it('reads an image wiki-link from the vault root, with the editor’s alt', async () => {
    const { markdown, asked } = await inline('![[assets/a.jpg]] `[[b.png]]`', 'n/note.md', jpg)
    expect(asked).toEqual(['assets/a.jpg'])
    expect(markdown).toBe(
      `<!--raw-typst #image(bytes((${bytesOf(jpg)})), format: "jpg", alt: "assets/a.jpg")--> \`[[b.png]]\``,
    )
  })

  it('leaves an image it cannot show as its alt text, and says why', async () => {
    const { markdown, warnings } = await inlineImages(
      '![Web](https://x.dk/a.png)\n![Mangler](a.png)\n![Bmp](a.bmp)',
      'note.md',
      async () => {
        throw new Error('no such file in the vault')
      },
    )
    expect(markdown).toBe('Web\nMangler\nBmp')
    expect(warnings).toEqual([
      'The image on line 1 is left out: https://x.dk/a.png is a web address, and a PDF only takes images from the vault',
      'The image on line 2 is left out: a.png: no such file in the vault',
      'The image on line 3 is left out: a.bmp is not an image Typst can read (png, jpg, gif, webp or svg)',
    ])
  })

  it('leaves out a file whose bytes are not its format, and an SVG that links out', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="x"><image href="other.png"/></svg>')
    const corrupt = await inline('![C](bad.png)', 'note.md', jpg)
    const linking = await inline('![S](s.svg)', 'note.md', svg)
    expect(corrupt.markdown).toBe('C')
    expect(corrupt.warnings).toEqual(['The image on line 1 is left out: bad.png is not a png file'])
    expect(linking.warnings).toEqual([
      'The image on line 1 is left out: s.svg is an SVG that links to another file',
    ])
  })
})
