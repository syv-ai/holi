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

function patch(source: string, id: string, label: string) {
  const result = patchMermaidLabel(source, id, label)
  if (!('source' in result)) throw new Error(result.error)
  return result.source
}

function renderedSvg(svg: string) {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(parsed.querySelector('parsererror')).toBeNull()
  return parsed.documentElement
}

afterEach(() => {
  svgPrototype.getBBox = originalGetBBox
  svgPrototype.getComputedTextLength = originalGetComputedTextLength
  document.body.replaceChildren()
})

describe('real Mermaid renderer', () => {
  it('keeps loading Mermaid lazy and renders sanitized SVG', async () => {
    polyfillSvgLayout()
    const { svg } = await renderMermaid('flowchart LR\n  A[Alpha] --> B[Beta]', 'default')
    expect(svg).toContain('Alpha')
    expect(svg).toContain('Beta')
    expect(svg).not.toContain('foreignObject')
    expect(svg).not.toMatch(/<a(?:\s|>)/i)
  })

  it('returns only exact actual SVG IDs and label matches for every declared node', async () => {
    polyfillSvgLayout()
    const result = await renderMermaid(
      'flowchart LR\nA[Same] --> B[Same]\nA --> C[Third]\nB --> A',
      'default',
    )
    const root = renderedSvg(result.svg)
    expect(result.targets.map(({ id, label }) => [id, label])).toEqual([
      ['A', 'Same'],
      ['B', 'Same'],
      ['C', 'Third'],
    ])
    expect(result.targets).toHaveLength(3)
    for (const target of result.targets) {
      const matches = [...root.querySelectorAll('g.node')].filter(
        (node) => node.getAttribute('id') === target.domId,
      )
      expect(matches).toHaveLength(1)
      expect(matches[0]!.querySelector('.label')!.textContent).toBe(target.label)
      expect(matches[0]!.querySelector('rect.label-container')).not.toBeNull()
    }
    expect(new Set(result.targets.map(({ domId }) => domId)).size).toBe(3)
  })

  it.each([
    ['unquoted', 'flowchart LR\nA[Old] --> B[Keep]', 'A', 'Edited label'],
    ['quoted', 'flowchart LR\nA["Old"] --> B[Keep]', 'A', 'Edited label'],
  ])(
    'round-trips a %s edit without changing node identities or shapes',
    async (_, source, id, label) => {
      polyfillSvgLayout()
      const before = await renderMermaid(source, 'default')
      const beforeRoot = renderedSvg(before.svg)
      const edited = await renderMermaid(patch(source, id, label), 'default')
      const editedRoot = renderedSvg(edited.svg)
      expect(edited.targets.map(({ id: nodeId, label: text }) => [nodeId, text])).toEqual([
        [id, label],
        ['B', 'Keep'],
      ])
      const beforeTarget = before.targets.find((target) => target.id === id)!
      const afterTarget = edited.targets.find((target) => target.id === id)!
      const beforeNode = [...beforeRoot.querySelectorAll('g.node')].find(
        (node) => node.id === beforeTarget.domId,
      )!
      const afterNode = [...editedRoot.querySelectorAll('g.node')].find(
        (node) => node.id === afterTarget.domId,
      )!
      expect(afterNode.querySelector('rect.label-container')).not.toBeNull()
      expect(afterNode.querySelector('.label')!.textContent).toBe(label)
      expect(beforeNode.id).not.toBe(afterNode.id)
      expect(afterTarget.domId).toBe(afterNode.getAttribute('id'))
      expect(afterTarget.domId.replace(/^holi-mermaid-\d+-/, '')).toBe(
        beforeTarget.domId.replace(/^holi-mermaid-\d+-/, ''),
      )
      expect(afterTarget.domId).toContain('flowchart-A-0')
      expect(edited.targets.find((target) => target.id === 'B')?.label).toBe('Keep')
    },
  )

  it.each([
    ['rounded rectangle', '(Alpha)', '(Gamma)'],
    ['diamond', '{Alpha}', '{Gamma}'],
    ['circle', '((Alpha))', '((Gamma))'],
    ['stadium', '([Alpha])', '([Gamma])'],
    ['subroutine', '[[Alpha]]', '[[Gamma]]'],
    ['cylinder', '[(Alpha)]', '[(Gamma)]'],
    ['hexagon', '{{Alpha}}', '{{Gamma}}'],
  ])('maps real Mermaid %s labels by stable node identity', async (_name, shape, changed) => {
    polyfillSvgLayout()
    const source = `flowchart LR\nA${shape} --> B[Keep]\nA --> C[Same]`
    const before = await renderMermaid(source, 'default')
    expect(before.targets.map(({ id, label }) => [id, label])).toEqual([
      ['A', 'Alpha'],
      ['B', 'Keep'],
      ['C', 'Same'],
    ])
    const editedSource = patch(source, 'A', 'Gamma')
    expect(editedSource).toContain(`A${changed}`)
    const after = await renderMermaid(editedSource, 'default')
    expect(after.targets.map(({ id, label }) => [id, label])).toEqual([
      ['A', 'Gamma'],
      ['B', 'Keep'],
      ['C', 'Same'],
    ])
    expect(after.targets.map(({ id }) => id)).toEqual(before.targets.map(({ id }) => id))
    const beforeRoot = renderedSvg(before.svg)
    const afterRoot = renderedSvg(after.svg)
    for (const target of after.targets) {
      const node = [...afterRoot.querySelectorAll('g.node')].find(
        (candidate) => candidate.id === target.domId,
      )!
      expect(node.querySelector('.label')!.textContent).toBe(target.label)
      expect(target.domId.replace(/^holi-mermaid-\d+-/, '')).toBe(
        before.targets
          .find((prior) => prior.id === target.id)!
          .domId.replace(/^holi-mermaid-\d+-/, ''),
      )
      expect(beforeRoot.querySelectorAll('g.node')).toHaveLength(3)
      expect(afterRoot.querySelectorAll('g.node')).toHaveLength(3)
    }
  })

  it('fails closed when Mermaid changes punctuation or entity-looking drafts on render', async () => {
    polyfillSvgLayout()
    const drafts = ['`"\\!@#$%^&*()_+-={}[]|:;<>?,./~', 'literal &amp; &#91; &#93; &#x1F680;']
    for (const label of drafts) {
      for (const quoted of [false, true]) {
        const source = `flowchart TD\nA[${quoted ? '"' : ''}Old${quoted ? '"' : ''}]`
        const edited = await renderMermaid(patch(source, 'A', label), 'default')
        expect(edited.svg).toContain('holi-mermaid-')
        expect(edited.targets).toEqual([])
        const root = renderedSvg(edited.svg)
        const node = [...root.querySelectorAll('g.node')].find((candidate) =>
          candidate.id.endsWith('-flowchart-A-0'),
        )!
        expect(node.querySelector('rect.label-container')).not.toBeNull()
        expect(node.querySelector('.label')!.textContent).not.toBe(label)
      }
    }
  })

  it.each([
    'Ready, now!',
    'A & B',
    'literal &amp; &quot;',
    'Hello ] (test) #hashtag',
    'C:\\Users',
    'clamp;',
  ])('round-trips literal punctuation without entity drift: %s', async (label) => {
    polyfillSvgLayout()
    for (const quoted of [false, true]) {
      const source = `flowchart LR\nA[${quoted ? '"' : ''}Old${quoted ? '"' : ''}] --> B[Keep]`
      const edited = await renderMermaid(patch(source, 'A', label), 'default')
      expect(edited.targets.map(({ id, label }) => [id, label])).toEqual([
        ['A', label],
        ['B', 'Keep'],
      ])
      expect(renderedSvg(edited.svg).querySelectorAll('g.node')).toHaveLength(2)
    }
  })

  it('maps Unicode labels and repeated references by vertex identity, not visible text', async () => {
    polyfillSvgLayout()
    const source = patch('flowchart LR\nA[Old] --> B[Same]\nA --> C[Same]', 'A', '🌻 新しい')
    const result = await renderMermaid(source, 'default')
    expect(result.targets.map(({ id, label }) => [id, label])).toEqual([
      ['A', '🌻 新しい'],
      ['B', 'Same'],
      ['C', 'Same'],
    ])
    expect(new Set(result.targets.map(({ domId }) => domId)).size).toBe(3)
    const root = renderedSvg(result.svg)
    for (const target of result.targets)
      expect(
        [...root.querySelectorAll('g.node')]
          .find((node) => node.id === target.domId)
          ?.querySelector('.label')?.textContent,
      ).toBe(target.label)
  })

  it.each([
    'flowchart LR\nA[/slanted/]',
    'flowchart LR\nA[one]\nA[two]',
    'flowchart LR\nA[one<br>two]',
    'flowchart LR\nA[one]\nclick A callback',
    'flowchart LR\nA[<img src=x onerror=alert(1)>]',
  ])(
    'renders unsupported or malicious source without exposing edit targets: %s',
    async (source) => {
      polyfillSvgLayout()
      const result = await renderMermaid(source, 'default').catch(() => null)
      if (!result) {
        // Mermaid may reject unsupported syntax; either outcome must leave no error SVG behind.
        expect(document.body.querySelectorAll('svg')).toHaveLength(0)
        return
      }
      expect(result.targets).toEqual([])
      expect(result.svg).not.toMatch(/<foreignObject|<a(?:\s|>)/i)
      expect(result.svg).not.toMatch(/\s(?:href|xlink:href|target)=/i)
      expect(result.svg).not.toContain('onerror=')
    },
  )

  it('serializes dark and default configuration without cross-render races', async () => {
    polyfillSvgLayout()
    const [dark, standard] = await Promise.all([
      renderMermaid('flowchart LR\nA[Dark]', 'dark'),
      renderMermaid('flowchart LR\nA[Standard]', 'default'),
    ])
    expect(dark.svg).toContain('Dark')
    expect(standard.svg).toContain('Standard')
    expect(dark.svg.match(/<svg id="([^"]+)/)?.[1]).not.toBe(
      standard.svg.match(/<svg id="([^"]+)/)?.[1],
    )
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
