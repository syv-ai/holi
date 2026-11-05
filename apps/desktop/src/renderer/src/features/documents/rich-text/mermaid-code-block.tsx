import CodeBlock from '@tiptap/extension-code-block'
import DOMPurify from 'dompurify'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'

let renderId = 0

// Mermaid receives note-authored text. DOMPurify is still the final gate before
// SVG reaches the document.
function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const [svg, setSvg] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
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
  }, [active, isMermaid, source, theme])

  useEffect(() => {
    const host = svgHost.current
    if (!host || !svg) return
    // Parse the sanitized document and attach its SVG node, never interpreting
    // the original source as HTML or using React's unsafe HTML escape hatch.
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = parsed.documentElement
    if (root.localName !== 'svg' || parsed.querySelector('parsererror')) {
      setRenderError(true)
      return
    }
    host.replaceChildren(document.importNode(root, true))
  }, [svg])

  const showDiagram = isMermaid && !active && source.trim() !== '' && !renderError

  return (
    <NodeViewWrapper className="tiptap-code-block">
      {showDiagram ? (
        <div
          ref={svgHost}
          data-mermaid-diagram=""
          contentEditable={false}
          role={svg ? 'img' : 'status'}
          aria-label={svg ? 'Mermaid diagram' : 'Rendering diagram'}
          onMouseDown={(event) => {
            const position = currentPosition()
            if (editable && typeof position === 'number') {
              event.preventDefault()
              editor.commands.setTextSelection(Math.min(position + 1, position + node.nodeSize - 1))
              editor.view.focus()
            }
          }}
        >
          {svg ? null : <span className="text-muted-foreground text-sm">Rendering diagram…</span>}
        </div>
      ) : null}
      <NodeViewContent
        className={showDiagram ? 'hidden' : undefined}
        data-mermaid-source={isMermaid ? '' : undefined}
      />
      {renderError && isMermaid ? (
        <p role="status" className="text-muted-foreground text-sm">
          Couldn&apos;t draw this diagram
        </p>
      ) : null}
    </NodeViewWrapper>
  )
}

/** Code blocks with Mermaid preview while their source is not selected. */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockView, { as: 'pre' })
  },
})
