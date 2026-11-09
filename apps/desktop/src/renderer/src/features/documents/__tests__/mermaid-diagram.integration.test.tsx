import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MermaidDiagram } from '../rich-text/mermaid-diagram'

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

describe('real Mermaid SVG styling', () => {
  it('rewrites generated CSS selectors and URL references per rendered instance', async () => {
    polyfillSvgLayout()
    const source = `flowchart LR\n  A[Alpha]:::custom --> B[Beta]\n  classDef custom fill:#ff0000,stroke:#0000ff,color:#ffffff`
    const view = render(
      <>
        <MermaidDiagram source={source} theme="default" />
        <MermaidDiagram source={source} theme="default" enlarged />
      </>,
    )
    await waitFor(() => expect(view.container.querySelectorAll('svg')).toHaveLength(2))

    const [first, second] = Array.from(view.container.querySelectorAll<SVGSVGElement>('svg'))
    const ids = Array.from(view.container.querySelectorAll<SVGElement>('[id]'))
    expect(new Set(ids.map((element) => element.id)).size).toBe(ids.length)
    for (const drawing of [first!, second!]) {
      const style = drawing.querySelector('style')?.textContent ?? ''
      const scopedId = drawing.id
      expect(style).toContain(`#${scopedId}`)
      expect(style).not.toMatch(/#mermaid-[\w-]+(?=\s|\.)/)
      expect(style).toContain('.custom rect{fill:#ff0000!important;stroke:#0000ff!important')
      expect(drawing.querySelector('[data-mermaid-original-id]')).toBeTruthy()
    }
    expect(first!.id).not.toBe(second!.id)
    expect(first!.style.maxWidth).toBe('116px')
    expect(second!.style.maxWidth).toBe('none')
    expect(first!.querySelector('style')?.textContent).not.toBe(
      second!.querySelector('style')?.textContent,
    )
    view.unmount()
  })
})
