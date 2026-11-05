import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { analyseMermaidLabels } from '@holi/shared'

export type MermaidTarget = { id: string; domId: string; label: string }
export type MermaidRender = { svg: string; targets: MermaidTarget[] }
let queue: Promise<void> = Promise.resolve()
let nextId = 0

/** Serializes Mermaid's shared global configuration, rendering and its version-specific graph adapter. */
export function renderMermaid(source: string, theme: 'dark' | 'default'): Promise<MermaidRender> {
  const task = queue.then(async () => {
    const id = `holi-mermaid-${++nextId}`
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      htmlLabels: false,
      suppressErrorRendering: true,
    })
    let mapping: MermaidTarget[] = []
    try {
      const api = mermaid.mermaidAPI as unknown as {
        getDiagramFromText?: (text: string) => Promise<{
          db?: {
            getVertices?: () =>
              | Map<string, { id?: string; domId?: string }>
              | Record<string, { id?: string; domId?: string }>
          }
        }>
      }
      const diagram = await api.getDiagramFromText?.(source)
      const vertices = diagram?.db?.getVertices?.()
      const analysis = analyseMermaidLabels(source)
      if (analysis.supported && vertices) {
        mapping = analysis.labels.flatMap((label) => {
          const vertex = vertices instanceof Map ? vertices.get(label.id) : vertices[label.id]
          return vertex?.domId ? [{ id: label.id, domId: vertex.domId, label: label.label }] : []
        })
        if (mapping.length !== analysis.labels.length) mapping = []
      }
    } catch {
      mapping = []
    }
    try {
      const result = await mermaid.render(id, source)
      const svg = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true },
        FORBID_TAGS: ['a', 'foreignObject'],
        FORBID_ATTR: ['href', 'xlink:href', 'target'],
      })
      if (!mapping.length) return { svg, targets: [] }
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const root = parsed.documentElement
      if (root.localName !== 'svg' || parsed.querySelector('parsererror'))
        return { svg, targets: [] }
      const nodes = [...root.querySelectorAll('g.node')]
      const targets: MermaidTarget[] = []
      for (const target of mapping) {
        const node = nodes.find(
          (candidate) => candidate.getAttribute('id') === `${id}-${target.domId}`,
        )
        if (!node || !node.querySelector('.label')) return { svg, targets: [] }
        targets.push(target)
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
