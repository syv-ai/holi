import DOMPurify from 'dompurify'
import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

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
}: {
  source: string
  theme: 'dark' | 'default'
  enlarged?: boolean
  className?: string
}) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const host = useRef<HTMLDivElement>(null)
  const instanceId = `holi-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    let current = true
    setSvg(null)
    setError(false)
    void import('mermaid')
      .then(({ default: mermaid }) => {
        if (!current) return null
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          htmlLabels: false,
          suppressErrorRendering: true,
        })
        return mermaid.render(instanceId, source)
      })
      .then((result) => {
        if (current && result) {
          setSvg(
            DOMPurify.sanitize(result.svg, {
              USE_PROFILES: { svg: true },
              FORBID_TAGS: ['a'],
              FORBID_ATTR: ['href', 'xlink:href', 'target'],
              ADD_ATTR: ['id', 'aria-labelledby'],
            }),
          )
        }
      })
      .catch(() => {
        document.getElementById(instanceId)?.remove()
        if (current) setError(true)
      })
    return () => {
      current = false
    }
  }, [instanceId, source, theme, retry])

  useEffect(() => {
    const target = host.current
    if (!target) return
    target.replaceChildren()
    if (!svg) return
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
  }, [enlarged, instanceId, svg])

  if (error) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Couldn&apos;t draw this diagram{' '}
        <Button type="button" variant="link" onClick={() => setRetry((version) => version + 1)}>
          Retry
        </Button>
      </p>
    )
  }
  return (
    <>
      {!svg ? (
        <span role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
          <Skeleton aria-hidden="true" className="size-4" />
          Rendering diagram…
        </span>
      ) : null}
      <div
        ref={host}
        className={className ?? 'max-w-fit [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-full'}
        data-mermaid-diagram=""
        role={svg ? 'img' : 'status'}
        aria-label={svg ? 'Mermaid diagram' : 'Rendering diagram'}
      />
    </>
  )
}
