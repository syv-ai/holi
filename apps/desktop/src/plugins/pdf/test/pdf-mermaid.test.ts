/**
 * A note's mermaid fences become diagrams for Typst, and one that will not
 * draw stays code.
 */
import { describe, expect, it } from 'vitest'
import { drawMermaid, type DrawDiagrams } from '../main/mermaid'

const drawsAll: DrawDiagrams = async (sources) => sources.map((s) => ({ svg: `<svg>${s}</svg>` }))

describe('drawMermaid', () => {
  it('puts each mermaid fence’s drawing where the fence was, and leaves other code', async () => {
    const md = '# T\n\n```mermaid\nflowchart LR\n```\n\n```js\nx()\n```\n'
    const { markdown, warnings } = await drawMermaid(md, drawsAll)
    expect(markdown).toMatch(/^# T\n\n<!--raw-typst #align\(center, image\(bytes\(".*"\)/)
    expect(markdown).not.toContain('```mermaid')
    expect(markdown).toContain('```js\nx()\n```\n')
    expect(warnings).toEqual([])
  })

  it('sends mermaid the fence body as written, wiki-link look-alikes included', async () => {
    const seen: string[] = []
    await drawMermaid('```mermaid\nflowchart LR\n  A[[sub]]\n```\n', async (sources) => {
      seen.push(...sources)
      return sources.map(() => ({ svg: '<svg/>' }))
    })
    expect(seen).toEqual(['flowchart LR\n  A[[sub]]'])
  })

  it('keeps a diagram that will not draw as code, and says which', async () => {
    const md = 'a\n\n```mermaid\nnot a diagram\n```\n'
    const { markdown, warnings } = await drawMermaid(md, async () => [
      { error: 'Parse error on line 1:\n...' },
    ])
    expect(markdown).toBe(md)
    expect(warnings).toEqual(['The diagram on line 3 shows as code: Parse error on line 1:'])
  })

  it('cannot end its comment early, whatever the drawing holds', async () => {
    const { markdown } = await drawMermaid('```mermaid\nx\n```', async () => [
      { svg: '<svg>\n<text>A --> "B" \\</text>\n</svg>' },
    ])
    expect(markdown.indexOf('-->')).toBe(markdown.length - 3)
    expect(markdown).not.toContain('\n')
  })

  it('leaves a note without diagrams alone and never calls mermaid', async () => {
    const md = '```\nplain\n```\n'
    const never: DrawDiagrams = async () => {
      throw new Error('called')
    }
    expect(await drawMermaid(md, never)).toEqual({ markdown: md, warnings: [] })
  })
})
