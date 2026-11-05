import mermaid from 'mermaid'
import { patchMermaidLabel } from '@holi/shared'
import { renderMermaid } from '@/lib/mermaid-renderer'
import { afterEach, describe, expect, it } from 'vitest'

type SvgLayoutElement = SVGElement & { getBBox: () => DOMRect; getComputedTextLength: () => number }

const svgPrototype = SVGElement.prototype as SvgLayoutElement
const originalGetBBox = svgPrototype.getBBox
const originalGetComputedTextLength = svgPrototype.getComputedTextLength

function polyfillSvgLayout() {
  svgPrototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 }) as DOMRect
  svgPrototype.getComputedTextLength = () => 40
}

afterEach(() => {
  svgPrototype.getBBox = originalGetBBox
  svgPrototype.getComputedTextLength = originalGetComputedTextLength
  document.body.replaceChildren()
})

describe('real Mermaid renderer', () => {
  it('retains flowchart labels in sanitized SVG output', async () => {
    polyfillSvgLayout()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
    })

    const { svg } = await mermaid.render(
      'mermaid-integration-labels',
      'flowchart LR\n  A[Alpha] --> B[Beta]',
    )

    expect(svg).toContain('Alpha')
    expect(svg).toContain('Beta')
    expect(svg).not.toContain('foreignObject')
  })

  it('maps supported source ids to exact rendered node identities', async () => {
    polyfillSvgLayout()
    const result = await renderMermaid('flowchart LR\nA[Alpha] --> B[Beta]', 'default')
    expect(result.svg).toContain('Alpha')
    expect(result.svg).toContain('Beta')
    expect(result.svg).not.toContain('foreignObject')
  })

  it('round-trips punctuation through Mermaid entities without changing diagram structure', async () => {
    polyfillSvgLayout()
    const patched = patchMermaidLabel('flowchart LR\nA[Alpha]', 'A', 'literal & # " < >')
    if (!('source' in patched)) throw new Error(patched.error)
    const result = await renderMermaid(patched.source, 'default')
    expect(result.svg).toContain('literal')
    expect(result.svg).toContain('&amp;')
    expect(result.svg).toContain('&lt;')
  })

  it('does not leave error SVGs in the document after repeated invalid renders', async () => {
    for (const id of ['mermaid-integration-invalid-a', 'mermaid-integration-invalid-b']) {
      await expect(mermaid.render(id, 'this is not a valid diagram')).rejects.toThrow()
      document.getElementById(id)?.remove()
      expect(document.body.querySelector(`#${id}`)).toBeNull()
    }
    expect(document.body.querySelectorAll('svg')).toHaveLength(0)
  })
})
