import mermaid from 'mermaid'
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

  it('does not leave error SVGs in the document after repeated invalid renders', async () => {
    for (const id of ['mermaid-integration-invalid-a', 'mermaid-integration-invalid-b']) {
      await expect(mermaid.render(id, 'this is not a valid diagram')).rejects.toThrow()
      document.getElementById(id)?.remove()
      expect(document.body.querySelector(`#${id}`)).toBeNull()
    }
    expect(document.body.querySelectorAll('svg')).toHaveLength(0)
  })
})
