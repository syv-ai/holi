import DOMPurify from 'dompurify'
import { analyseMermaidLabels } from '@holi/shared'

export type MermaidTarget = { id: string; domId: string; label: string }
export type MermaidRender = { svg: string; targets: MermaidTarget[] }
let queue: Promise<void> = Promise.resolve()
let nextId = 0

/** Serializes Mermaid's global configuration, parsing, and rendering behind a lazy-loaded adapter. */
export function renderMermaid(source: string, theme: 'dark' | 'default'): Promise<MermaidRender> {
  const task = queue.then(async () => {
    const id = `holi-mermaid-${++nextId}`
    try {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        htmlLabels: false,
        suppressErrorRendering: true,
      })

      let diagram:
        | {
            db?: {
              getVertices?: () =>
                | Map<string, { id?: string; domId?: string; text?: string; label?: string }>
                | Record<string, { id?: string; domId?: string; text?: string; label?: string }>
            }
          }
        | undefined
      try {
        const api = mermaid.mermaidAPI as unknown as {
          getDiagramFromText?: (text: string) => Promise<typeof diagram> | typeof diagram
        }
        diagram = await api.getDiagramFromText?.(source)
      } catch {
        // Parsing for edit targets is optional. Mermaid still gets the source to render below.
      }

      const result = await mermaid.render(id, source)
      const svg = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true },
        FORBID_TAGS: ['a', 'foreignObject'],
        FORBID_ATTR: ['href', 'xlink:href', 'target'],
      })
      const analysis = analyseMermaidLabels(source)
      let vertices:
        | Map<string, { id?: string; domId?: string; text?: string; label?: string }>
        | Record<string, { id?: string; domId?: string; text?: string; label?: string }>
        | undefined
      try {
        vertices = diagram?.db?.getVertices?.()
      } catch {
        // A changed or incomplete Mermaid DB capability disables editing, not rendering.
      }
      if (!analysis.supported || !vertices || analysis.labels.length === 0)
        return { svg, targets: [] }

      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const root = parsed.documentElement
      if (
        root.localName !== 'svg' ||
        root.getAttribute('id') !== id ||
        parsed.querySelector('parsererror')
      )
        return { svg, targets: [] }

      const nodes = [...root.querySelectorAll('g.node')]
      const targets: MermaidTarget[] = []
      const seen = new Set<string>()
      for (const label of analysis.labels) {
        const vertex = vertices instanceof Map ? vertices.get(label.id) : vertices[label.id]
        if (!vertex || vertex.id !== label.id || !vertex.domId || seen.has(vertex.domId))
          return { svg, targets: [] }
        seen.add(vertex.domId)

        // Mermaid 11.17.2's flowchart DB exposes a node domId relative to the render
        // root. Resolve it against that real root, then return the matched SVG id itself.
        const actualId = `${root.getAttribute('id')}-${vertex.domId}`
        const matches = nodes.filter((node) => node.getAttribute('id') === actualId)
        if (matches.length !== 1 || vertex.text !== label.label) return { svg, targets: [] }
        const node = matches[0]!
        const labelElement = node.querySelector('.label')
        if (!labelElement || labelElement.textContent !== label.label) return { svg, targets: [] }
        targets.push({ id: label.id, domId: node.getAttribute('id')!, label: label.label })
      }
      return { svg, targets }
    } catch (error) {
      document.getElementById(id)?.remove()
      throw error
    }
  })
  queue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
