import CodeBlock from '@tiptap/extension-code-block'
import { patchMermaidLabel } from '@holi/shared'
import { renderMermaid, type MermaidTarget } from '@/lib/mermaid-renderer'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const [svg, setSvg] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
  const [targets, setTargets] = useState<MermaidTarget[]>([])
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<MermaidTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState('')
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
    setTargets([])
    if (!isMermaid || source.trim() === '' || active) return () => void (current = false)

    void renderMermaid(source, theme)
      .then((result) => {
        if (current) {
          setSvg(result.svg)
          setTargets(result.targets)
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

  useEffect(() => {
    if (!editable || active) {
      setEditing(false)
      setSelected(null)
      setEditError('')
    }
  }, [active, editable])

  const showDiagram = isMermaid && !active && source.trim() !== '' && !renderError
  function applyLabel() {
    if (!selected || !editable) return
    const patched = patchMermaidLabel(source, selected.id, draft)
    if ('error' in patched) {
      setEditError(patched.error)
      return
    }
    const position = currentPosition()
    if (typeof position !== 'number' || editor.state.doc.nodeAt(position)?.textContent !== source) {
      setSelected(null)
      return
    }
    let start = 0
    while (start < source.length && source[start] === patched.source[start]) start++
    let end = 0
    while (
      end < source.length - start &&
      source[source.length - 1 - end] === patched.source[patched.source.length - 1 - end]
    )
      end++
    const transaction = editor.state.tr.insertText(
      patched.source.slice(start, patched.source.length - end),
      position + 1 + start,
      position + 1 + source.length - end,
    )
    editor.view.dispatch(transaction)
    setSelected(null)
    setEditing(false)
    editor.view.focus()
  }

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
            if ((event.target as Element).closest('[data-label-target]')) return
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
      {showDiagram && editable ? (
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Done' : 'Edit labels'}
          </Button>
          <Button
            type="button"
            variant="text"
            onClick={() => {
              const position = currentPosition()
              if (typeof position === 'number') {
                editor.commands.setTextSelection(position + 1)
                editor.view.focus()
              }
            }}
          >
            Edit source
          </Button>
        </div>
      ) : null}
      {editing ? (
        <div className="flex flex-wrap gap-2" aria-label="Diagram labels">
          {targets.length ? (
            targets.map((target) => (
              <Button
                type="button"
                key={target.id}
                variant="outline"
                data-label-target=""
                onClick={() => {
                  setSelected(target)
                  setDraft(target.label)
                  setEditError('')
                }}
              >
                {target.label}
              </Button>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              Labels cannot be safely edited for this diagram. Edit source instead.
            </p>
          )}
        </div>
      ) : null}
      {selected ? (
        <div className="flex gap-2" role="group" aria-label={`Edit ${selected.id} label`}>
          <Input
            aria-label="Label"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSelected(null)
                setEditError('')
              }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) applyLabel()
            }}
          />
          <Button type="button" onClick={applyLabel}>
            Apply
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSelected(null)
              setEditError('')
            }}
          >
            Cancel
          </Button>
          {editError ? <p role="alert">{editError}</p> : null}
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
