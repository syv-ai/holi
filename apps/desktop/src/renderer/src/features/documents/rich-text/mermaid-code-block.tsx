import CodeBlock from '@tiptap/extension-code-block'
import DOMPurify from 'dompurify'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { RenderedMediaLightbox } from './rendered-media-lightbox'
import { RenderedMediaAction, RenderedMediaToolbar } from './rendered-media-toolbar'

import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'

let renderId = 0

// Mermaid receives note-authored text. DOMPurify is still the final gate before
// SVG reaches the document.
function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const [svg, setSvg] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
  const activeMode = useAtomValue(activeModeAtom)
  const theme = activeMode === 'dark' ? 'dark' : 'default'
  const svgHost = useRef<HTMLDivElement>(null)
  const source = node.textContent
  const isMermaid = String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  const editable = editor.isEditable
  const currentPosition = () => (typeof getPos === 'function' ? getPos() : undefined)
  useEffect(() => {
    const focus = () => setFocused(true)
    const blur = () => setFocused(false)
    editor.on('focus', focus)
    editor.on('blur', blur)
    return () => {
      editor.off('focus', focus)
      editor.off('blur', blur)
    }
  }, [editor])

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const position = currentPosition()
      if (position === undefined) return false
      const { from, to } = current.state.selection
      return (
        current.isEditable && focused && from >= position + 1 && to <= position + node.nodeSize - 1
      )
    },
  })

  useEffect(() => {
    let current = true
    setSvg(null)
    setRenderError(false)
    if (!isMermaid || source.trim() === '' || active) return () => void (current = false)

    const id = `holi-mermaid-${++renderId}`
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
        return mermaid.render(id, source)
      })
      .then((result) => {
        if (current && result) {
          setSvg(
            DOMPurify.sanitize(result.svg, {
              USE_PROFILES: { svg: true },
              FORBID_TAGS: ['a'],
              FORBID_ATTR: ['href', 'xlink:href', 'target'],
            }),
          )
        }
      })
      .catch(() => {
        // Mermaid may append its own error SVG to the document before rejecting.
        document.getElementById(id)?.remove()
        if (current) setRenderError(true)
      })
    return () => {
      current = false
    }
  }, [active, isMermaid, source, theme, retryVersion])

  useEffect(() => {
    const host = svgHost.current
    if (!host) return
    host.replaceChildren()
    if (!svg) return
    // Parse the sanitized document and attach its SVG node, never interpreting
    // the original source as HTML or using React's unsafe HTML escape hatch.
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = parsed.documentElement
    if (root.localName !== 'svg' || parsed.querySelector('parsererror')) {
      setRenderError(true)
      return
    }
    root.style.maxWidth = '100%'
    host.replaceChildren(document.importNode(root, true))
  }, [svg])

  const showDiagram = isMermaid && !active && source.trim() !== '' && !renderError
  const editSource = () => {
    const position = currentPosition()
    if (typeof position !== 'number') return
    editor.commands.setTextSelection(Math.min(position + 1, position + node.nodeSize - 1))
    editor.view.focus()
  }

  return (
    <NodeViewWrapper className="tiptap-code-block">
      {showDiagram ? (
        <div contentEditable={false} className="group/media relative max-w-fit" data-media-root="">
          <RenderedMediaToolbar>
            {editable ? (
              <RenderedMediaAction onClick={editSource}>Edit source</RenderedMediaAction>
            ) : null}
            <RenderedMediaAction asChild>
              <a
                href="#"
                onClick={(event) => {
                  event.preventDefault()
                  event.currentTarget
                    .closest('[data-media-root]')
                    ?.querySelector<HTMLButtonElement>('[aria-label="Open Mermaid diagram"]')
                    ?.click()
                }}
              >
                Open larger
              </a>
            </RenderedMediaAction>
          </RenderedMediaToolbar>
          {!svg ? (
            <span role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
              <Skeleton aria-hidden="true" className="size-4" />
              Rendering diagram…
            </span>
          ) : null}
          <RenderedMediaLightbox title="Mermaid diagram" preview={<SvgPreview svg={svg} />}>
            <div
              ref={svgHost}
              data-mermaid-diagram=""
              contentEditable={false}
              role={svg ? 'img' : 'status'}
              aria-label={svg ? 'Mermaid diagram' : 'Rendering diagram'}
            />
          </RenderedMediaLightbox>
        </div>
      ) : null}
      <NodeViewContent
        className={showDiagram ? 'hidden' : undefined}
        data-mermaid-source={isMermaid ? '' : undefined}
      />
      {renderError && isMermaid ? (
        <p role="status" contentEditable={false} className="text-muted-foreground text-sm">
          Couldn&apos;t draw this diagram{' '}
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setRenderError(false)
              setRetryVersion((version) => version + 1)
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
    </NodeViewWrapper>
  )
}

function SvgPreview({ svg }: { svg: string | null }) {
  const instanceId = useId().replace(/:/g, '')
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    host.current.replaceChildren()
    if (!svg) return
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (parsed.documentElement.localName === 'svg' && !parsed.querySelector('parsererror')) {
      const root = parsed.documentElement
      root.style.maxWidth = '100%'
      const ids = new Map<string, string>()
      for (const element of [root, ...root.querySelectorAll('[id]')]) {
        const original = element.id
        if (!original) continue
        const replacement = `${instanceId}-${original}`
        ids.set(original, replacement)
        element.setAttribute('data-mermaid-source-id', original)
        element.id = replacement
      }
      for (const element of [root, ...root.querySelectorAll('*')]) {
        for (const attribute of Array.from(element.attributes)) {
          const value = attribute.value.replace(
            /url\(#([^)]+)\)/g,
            (_, id: string) => `url(#${ids.get(id) ?? id})`,
          )
          const referenced = ids.get(value.replace(/^#/, ''))
          if (value !== attribute.value) element.setAttribute(attribute.name, value)
          else if (attribute.value.startsWith('#') && referenced)
            element.setAttribute(attribute.name, `#${referenced}`)
        }
      }
      host.current.replaceChildren(document.importNode(root, true))
    }
  }, [instanceId, svg])
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
        className="flex min-h-24 w-full max-w-full items-center justify-center overflow-auto [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:w-full [&_svg]:max-w-full"
      />
    </>
  )
}

/** Code blocks with Mermaid preview while their source is not selected. */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    const renderView = ReactNodeViewRenderer(MermaidCodeBlockView, { as: 'pre' })
    return (props) => {
      const view = renderView(props)
      const ignoreMutation = view.ignoreMutation?.bind(view)
      view.ignoreMutation = (mutation) => {
        if (mutation.type === 'selection') {
          const anchor = view.dom.ownerDocument.getSelection()?.anchorNode
          // Rendered controls are not the code block's editable source.
          if (anchor && !view.contentDOM?.contains(anchor)) return true
        }
        return ignoreMutation?.(mutation) ?? false
      }
      return view
    }
  },
})
