import { EditorActivityContext, useEditorActivity } from '@/hooks/use-editor-activity'
import CodeBlock from '@tiptap/extension-code-block'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'
import { RenderedMediaLightbox } from './rendered-media-lightbox'
import { RenderedMediaAction, RenderedMediaToolbar } from './rendered-media-toolbar'
import { MermaidDiagram } from './mermaid-diagram'
import { useMermaidLabelEditing } from './use-mermaid-label-editing'

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const activity = useEditorActivity(editor)
  const [editable, setEditable] = useState(() => editor.isEditable)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const activeMode = useAtomValue(activeModeAtom)
  const theme = activeMode === 'dark' ? 'dark' : 'default'
  const source = node.textContent
  const isMermaid = String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  const currentPosition = useCallback(
    () => (typeof getPos === 'function' ? getPos() : undefined),
    [getPos],
  )
  const labels = useMermaidLabelEditing({ node, editor, getPos, theme })
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const position = currentPosition()
      if (position === undefined) return false
      const { from, to } = current.state.selection
      return (
        current.isEditable &&
        current.view.hasFocus() &&
        from >= position + 1 &&
        to <= position + node.nodeSize - 1
      )
    },
  })

  useEffect(() => {
    const changed = () => setEditable(editor.isEditable)
    editor.on('transaction', changed)
    editor.on('update', changed)
    const observer = new MutationObserver(changed)
    observer.observe(editor.view.dom, { attributes: true, attributeFilter: ['contenteditable'] })
    return () => {
      observer.disconnect()
      editor.off('transaction', changed)
      editor.off('update', changed)
    }
  }, [editor])

  const showDiagram = isMermaid && !active && source.trim() !== ''
  const editSource = useCallback(() => {
    const position = currentPosition()
    if (activity.focused && typeof position === 'number') {
      editor.commands.setTextSelection(Math.min(position + 1, position + node.nodeSize - 1))
      editor.view.focus()
    }
  }, [currentPosition, editor, node.nodeSize, activity])

  return (
    <EditorActivityContext value={activity}>
      <NodeViewWrapper className="tiptap-code-block">
        {showDiagram ? (
          <div
            className="group/media relative max-w-fit"
            data-media-root=""
            contentEditable={false}
          >
            <RenderedMediaToolbar editor={editor}>
              {editable ? (
                <>
                  {labels.targets.length > 0 ? (
                    <RenderedMediaAction onClick={labels.toggleEditing}>
                      {labels.editing ? 'Done' : 'Edit labels'}
                    </RenderedMediaAction>
                  ) : null}
                  <RenderedMediaAction onClick={editSource}>Edit source</RenderedMediaAction>
                </>
              ) : null}
              <RenderedMediaAction
                ref={openButton}
                aria-label="Open Mermaid diagram"
                onClick={() => setLightboxOpen(true)}
              >
                Open larger
              </RenderedMediaAction>
            </RenderedMediaToolbar>
            <div onDoubleClick={() => setLightboxOpen(true)}>
              <MermaidDiagram source={source} theme={theme} onRendered={labels.onRendered} />
            </div>
            <RenderedMediaLightbox
              title="Mermaid diagram"
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
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
        {labels.editor}
        <NodeViewContent
          className={showDiagram ? 'hidden' : undefined}
          data-mermaid-source={isMermaid ? '' : undefined}
        />
      </NodeViewWrapper>
    </EditorActivityContext>
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
