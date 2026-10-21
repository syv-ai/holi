/**
 * A note's mermaid fences, drawn as diagrams for Typst.
 *
 * Mermaid needs a browser, so the drawing is a function handed in
 * (`mermaid-window.ts` in the app, a fake in the tests); this module finds the
 * fences and puts each SVG where its fence was.
 *
 * Each diagram goes in as a `<!--raw-typst … -->` comment holding the SVG
 * itself, not as `![](file.svg)`: cmarker evaluates a markdown image inside
 * its own package, so a path, absolute or not, resolves against cmarker and
 * not the disk. Raw Typst in a comment is cmarker's own way in, and every
 * template that renders through cmarker draws the diagram unchanged.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { fencedBlocks } from '@holi/shared'

/** One diagram's drawing: its SVG, or why mermaid would not draw it. */
export type Diagram = { svg: string } | { error: string }

/** Draws each mermaid source, in order, one result per source. */
export type DrawDiagrams = (sources: string[]) => Promise<Diagram[]>

/**
 * The SVG as a Typst string literal that can sit inside an HTML comment:
 * every `>` is an escape, so no `-->` can end the comment early, and the
 * literal stays on one line.
 */
function svgLiteral(svg: string): string {
  const escaped = svg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/>/g, '\\u{3e}')
  return `"${escaped}"`
}

/** The markdown that stands in for a fence: a centred diagram, in Typst. */
export function diagramMarkdown(svg: string): string {
  return `<!--raw-typst #align(center, image(bytes(${svgLiteral(svg)}), format: "svg", alt: "Diagram"))-->`
}

/**
 * `markdown` with every closed ```` ```mermaid ```` fence drawn. A diagram
 * mermaid cannot draw keeps its fence, so the PDF shows the source as code,
 * and says so in `warnings`: one diagram never fails the whole PDF.
 *
 * `prose` rewrites the markdown around the drawn diagrams and never a
 * diagram itself, so a rewrite such as wiki-links to text cannot reach into
 * an SVG whose label holds `[[`. Each diagram keeps its fence's indent, so
 * one in a list item stays in the item.
 */
export async function drawMermaid(
  markdown: string,
  draw: DrawDiagrams,
  prose: (markdown: string) => string = (m) => m,
): Promise<{ markdown: string; warnings: string[] }> {
  const fences = fencedBlocks(markdown).filter((b) => b.lang === 'mermaid')
  if (fences.length === 0) return { markdown: prose(markdown), warnings: [] }

  const diagrams = await draw(fences.map((f) => f.body))
  const warnings: string[] = []
  let out = ''
  let at = 0
  fences.forEach((fence, i) => {
    const diagram = diagrams[i] ?? { error: 'no drawing came back' }
    if ('error' in diagram) {
      const why = diagram.error.split('\n')[0]!.trim()
      warnings.push(`The diagram on line ${fence.line} shows as code: ${why}`)
      return
    }
    const indent = /^ */.exec(markdown.slice(fence.from))![0]
    out += prose(markdown.slice(at, fence.from)) + indent + diagramMarkdown(diagram.svg)
    at = fence.to
  })
  return { markdown: out + prose(markdown.slice(at)), warnings }
}
