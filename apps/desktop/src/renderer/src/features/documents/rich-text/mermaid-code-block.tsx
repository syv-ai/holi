import CodeBlock from '@tiptap/extension-code-block'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

import { useAtomValue } from 'jotai'

import { RenderedMediaLightbox } from './rendered-media-lightbox'
import { RenderedMediaAction, RenderedMediaToolbar } from './rendered-media-toolbar'
import { MermaidDiagram } from './mermaid-diagram'
import { activeModeAtom } from '@/state/color-scheme'

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
  const [open, setOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const activeMode = useAtomValue(activeModeAtom)
  const theme = activeMode === 'dark' ? 'dark' : 'default'
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
  const showDiagram = isMermaid && !active && source.trim() !== ''
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
            <RenderedMediaAction
              ref={openButton}
              aria-label="Open Mermaid diagram"
              onClick={() => setOpen(true)}
            >
              Open larger
            </RenderedMediaAction>
          </RenderedMediaToolbar>
          <div onDoubleClick={() => setOpen(true)}>
            <MermaidDiagram source={source} theme={theme} />
          </div>
          <RenderedMediaLightbox
            title="Mermaid diagram"
            open={open}
            onOpenChange={setOpen}
            restoreFocus={() => openButton.current?.focus()}
            preview={
              <MermaidDiagram
                source={source}
                theme={theme}
                enlarged
                className="flex min-h-24 w-full max-w-full items-center justify-center overflow-auto [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:w-full [&_svg]:max-w-full"
              />
            }
          >
            {null}
          </RenderedMediaLightbox>
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
    const renderView = ReactNodeViewRenderer(MermaidCodeBlockView, { as: 'pre' })
    return (props) => {
      const view = renderView(props)
      const ignoreMutation = view.ignoreMutation?.bind(view)
      view.ignoreMutation = (mutation) => {
        if (mutation.type === 'selection') {
          const anchor = view.dom.ownerDocument.getSelection()?.anchorNode
          if (anchor && !view.contentDOM?.contains(anchor)) return true
        }
        return ignoreMutation?.(mutation) ?? false
      }
      return view
    }
  },
})
