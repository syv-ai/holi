import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useEditorActivity } from '@/hooks/use-editor-activity'

import { Skeleton } from '@/components/ui/skeleton'
import { renderMermaid, type MermaidTarget } from '@/lib/mermaid-renderer'
import { ErrorState } from '@/composites/empty-state'

function rewriteCssIds(css: string, ids: Map<string, string>): string {
  const rewriteSelector = (selector: string) =>
    Array.from(ids.entries()).reduce((result, [original, replacement]) => {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return result.replace(new RegExp(`#${escaped}(?![\\w-])`, 'g'), `#${replacement}`)
    }, selector)
  const rewriteRules = (rules: string): string => {
    let result = ''
    let cursor = 0
    while (cursor < rules.length) {
      const open = rules.indexOf('{', cursor)
      if (open === -1) return result + rules.slice(cursor)
      let depth = 1
      let close = open + 1
      while (close < rules.length && depth > 0) {
        if (rules[close] === '{') depth += 1
        else if (rules[close] === '}') depth -= 1
        close += 1
      }
      const prelude = rules.slice(cursor, open)
      const body = rules.slice(open + 1, close - 1)
      const trimmed = prelude.trimStart()
      result += `${trimmed.startsWith('@') ? prelude : rewriteSelector(prelude)}{${trimmed.startsWith('@') ? rewriteRules(body) : body}}`
      cursor = close
    }
    return result
  }
  return rewriteRules(css).replace(/url\(#([^)]+)\)/g, (_, id: string) =>
    ids.has(id) ? `url(#${ids.get(id)})` : `url(#${id})`,
  )
}

/** Draw one sanitized Mermaid diagram; every drawing gets isolated SVG ids and references. */
export function MermaidDiagram({
  source,
  theme,
  enlarged = false,
  className,
  onRendered,
  renderTicket,
  renderContext,
  isRenderCurrent,
}: {
  source: string
  theme: 'dark' | 'default'
  enlarged?: boolean
  className?: string
  onRendered?: (root: SVGSVGElement, targets: MermaidTarget[]) => void
  /** Changes when this source block is replaced, moved, or its editability changes. */
  renderTicket?: unknown
  renderContext?: string
  isRenderCurrent?: () => boolean
}) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [targets, setTargets] = useState<MermaidTarget[]>([])
  const [renderedFor, setRenderedFor] = useState<{
    source: string
    theme: string
    renderTicket: unknown
    renderContext?: string
  } | null>(null)
  const renderMatches =
    renderedFor?.source === source &&
    renderedFor.theme === theme &&
    renderedFor.renderTicket === renderTicket &&
    renderedFor.renderContext === renderContext
  const isCurrent = useRef<() => boolean>(() => true)
  const host = useRef<HTMLDivElement>(null)
  const activity = useEditorActivity()
  const activitySnapshot = activity.snapshot()
  const instanceId = `holi-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    let current = true
    isCurrent.current = () => current
    setError(false)
    if (!activity.displayed) return
    void renderMermaid(source, theme)
      .then((result) => {
        if (current && isCurrent.current() && isRenderCurrent?.() !== false && activity.displayed) {
          setTargets(result.targets)
          setSvg(result.svg)
          setRenderedFor({ source, theme, renderTicket, renderContext })
        }
      })
      .catch(() => {
        document.getElementById(instanceId)?.remove()
        if (current && activity.displayed) setError(true)
      })
    return () => {
      current = false
    }
  }, [
    activity,
    activitySnapshot,
    instanceId,
    isRenderCurrent,
    renderContext,
    renderTicket,
    source,
    theme,
    retry,
  ])
  useLayoutEffect(() => {
    if (renderMatches) return
    host.current?.replaceChildren()
  }, [renderMatches])

  useEffect(() => {
    const target = host.current
    if (!target || !activity.displayed) return
    if (!svg || !renderMatches) return
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = parsed.documentElement
    if (root.localName !== 'svg' || parsed.querySelector('parsererror')) {
      setError(true)
      return
    }
    const ids = new Map<string, string>()
    for (const element of [root, ...root.querySelectorAll('[id]')]) {
      const original = element.id
      if (!original) continue
      const replacement = `${instanceId}-${original}`
      ids.set(original, replacement)
      const sourceId = original.startsWith(`${instanceId}-`)
        ? original.slice(instanceId.length + 1)
        : original
      element.setAttribute('data-mermaid-source-id', sourceId)
      element.setAttribute('data-mermaid-original-id', sourceId)
      element.id = replacement
    }
    for (const style of root.querySelectorAll('style')) {
      style.textContent = rewriteCssIds(style.textContent ?? '', ids)
    }
    for (const element of [root, ...root.querySelectorAll('*')]) {
      for (const attribute of Array.from(element.attributes)) {
        if (
          attribute.name === 'data-mermaid-source-id' ||
          attribute.name === 'data-mermaid-original-id'
        )
          continue
        const value = attribute.value.replace(/url\(#([^)]+)\)/g, (_, id: string) =>
          ids.has(id) ? `url(#${ids.get(id)})` : `url(#${id})`,
        )
        const reference = ids.get(value.replace(/^#/, ''))
        const idReferences = attribute.value
          .split(/\s+/)
          .map((id) => ids.get(id) ?? id)
          .join(' ')
        if (value !== attribute.value) element.setAttribute(attribute.name, value)
        else if (attribute.value.startsWith('#') && reference)
          element.setAttribute(attribute.name, `#${reference}`)
        else if (idReferences !== attribute.value)
          element.setAttribute(attribute.name, idReferences)
      }
    }
    if (enlarged) root.style.maxWidth = 'none'
    target.replaceChildren(document.importNode(root, true))
    const liveRoot = target.querySelector('svg')
    if (liveRoot) onRendered?.(liveRoot, targets)
  }, [activity, activitySnapshot, enlarged, instanceId, onRendered, renderMatches, svg, targets])

  if (error) {
    return (
      <ErrorState
        compact
        title="Couldn’t draw this diagram."
        onRetry={() => setRetry((version) => version + 1)}
      />
    )
  }
  return (
    <>
      {!renderMatches ? (
        <span role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
          <Skeleton aria-hidden="true" className="size-4" />
          Rendering diagram…
        </span>
      ) : null}
      <div
        ref={host}
        className={className ?? 'max-w-fit [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-full'}
        data-mermaid-diagram=""
        role={renderMatches ? (onRendered ? 'group' : 'img') : 'status'}
        aria-label={renderMatches ? 'Mermaid diagram' : 'Rendering diagram'}
      />
    </>
  )
}
