import { describe, expect, it } from 'vitest'
import { inlineImages } from '../main/images'

const bytes = new Uint8Array([1, 2, 3])

describe('inlineImages', () => {
  it('puts a relative image in as bytes, resolved against the note’s folder', async () => {
    const asked: string[] = []
    const { markdown, warnings } = await inlineImages(
      'Se ![Kort](../figurer/kort%20a.png "titel") her.',
      'kunder/acme/rapport.md',
      async (p) => (asked.push(p), bytes),
    )
    expect(asked).toEqual(['kunder/figurer/kort a.png'])
    expect(markdown).toBe(
      'Se <!--raw-typst #image(bytes((1,2,3)), format: "png", alt: "Kort")--> her.',
    )
    expect(warnings).toEqual([])
  })

  it('reads an image wiki-link from the vault root, and leaves code alone', async () => {
    const asked: string[] = []
    const note = '![[assets/a.jpg]]\n\n`![x](b.png)`\n\n```\n![y](c.png)\n```\n'
    const { markdown } = await inlineImages(note, 'n/note.md', async (p) => (asked.push(p), bytes))
    expect(asked).toEqual(['assets/a.jpg'])
    expect(markdown.startsWith('<!--raw-typst #image(bytes((1,2,3)), format: "jpg")-->')).toBe(true)
    expect(markdown).toContain('`![x](b.png)`')
    expect(markdown).toContain('![y](c.png)')
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
})
