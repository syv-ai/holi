import CodeBlock from '@tiptap/extension-code-block'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

let renderId = 0

// Mermaid receives note-authored text. Strict mode disables HTML labels and
// links; DOMPurify is still the final gate before SVG reaches the document.
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const [svg, setSvg] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
  const [theme, setTheme] = useState<'dark' | 'default'>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'default',
  )
  const svgHost = useRef<HTMLDivElement>(null)
  const source = node.textContent
  const isMermaid = String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  const editable = editor.isEditable
  const position = typeof getPos === 'function' ? getPos() : undefined
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
      if (position === undefined) return false
      const { from, to } = current.state.selection
      return (
        current.isEditable && focused && from >= position + 1 && to <= position + node.nodeSize - 1
      )
    },
  })

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() =>
      setTheme(root.classList.contains('dark') ? 'dark' : 'default'),
    )
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let current = true
    setSvg(null)
    setRenderError(false)
    if (!isMermaid || source.trim() === '' || active) return () => void (current = false)

    const id = `holi-mermaid-${++renderId}`
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
    void mermaid
      .render(id, source)
      .then(({ svg: result }) => {
        if (current) {
          setSvg(
            DOMPurify.sanitize(result, {
              USE_PROFILES: { svg: true },
              FORBID_TAGS: ['a'],
              FORBID_ATTR: ['href', 'xlink:href', 'target'],
            }),
          )
        }
      })
      .catch(() => {
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
    </NodeViewWrapper>
  )
}

/** Code blocks with Mermaid preview while their source is not selected. */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockView, { as: 'pre' })
  },
})
