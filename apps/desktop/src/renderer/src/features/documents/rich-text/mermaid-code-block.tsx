import CodeBlock from '@tiptap/extension-code-block'
import { minimalTextChange, patchMermaidLabel } from '@holi/shared'
import { renderMermaid, type MermaidTarget } from '@/lib/mermaid-renderer'
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { useStore } from 'jotai'
import { activeRemoteAtom } from '@/state/vaults'
import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'
import { RenderedMediaLightbox } from './rendered-media-lightbox'
import { RenderedMediaAction, RenderedMediaToolbar } from './rendered-media-toolbar'
import { MermaidDiagram } from './mermaid-diagram'
import { MermaidLabelEditor } from './mermaid-label-editor'

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const [editable, setEditable] = useState(() => editor.isEditable)
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const [targets, setTargets] = useState<MermaidTarget[]>([])
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<MermaidTarget | null>(null)
  const [anchor, setAnchor] = useState<Element | null>(null)
  const [validating, setValidating] = useState(false)
  const session = useRef(0)
  const editContext = useRef<{
    node: typeof node
    source: string
    remote: string | null
    theme: string
    anchor: Element
    id: string
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState('')
  const activeMode = useAtomValue(activeModeAtom)
  const store = useStore()
  const theme = activeMode === 'dark' ? 'dark' : 'default'
  const source = node.textContent
  const isMermaid = String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  const currentPosition = useCallback(
    () => (typeof getPos === 'function' ? getPos() : undefined),
    [getPos],
  )
  const closeEditor = useCallback(() => {
    session.current++
    editContext.current = null
    setSelected(null)
    setAnchor(null)
    setEditError('')
    setValidating(false)
  }, [])
  const editPosition = useCallback(() => {
    const context = editContext.current
    if (
      !context ||
      editor.isDestroyed ||
      !editor.isEditable ||
      store.get(activeRemoteAtom) !== context.remote ||
      (store.get(activeModeAtom) === 'dark' ? 'dark' : 'default') !== context.theme ||
      !context.anchor.isConnected
    )
      return undefined
    try {
      const position = currentPosition()
      return typeof position === 'number' && editor.state.doc.nodeAt(position) === context.node
        ? position
        : undefined
    } catch {
      return undefined
    }
  }, [currentPosition, editor, store])
  const finishEdit = useCallback(() => {
    const position = editPosition()
    const target = editContext.current?.anchor
    closeEditor()
    if (position !== undefined && target instanceof SVGElement) {
      const { from, to } = editor.state.selection
      const size = editor.state.doc.nodeAt(position)!.nodeSize
      if (from >= position + 1 && to <= position + size - 1)
        editor.commands.setNodeSelection(position)
      target.focus()
    }
  }, [editPosition, closeEditor, editor])
  useEffect(() => {
    const focus = () => {
      setFocused(true)
      if (editContext.current) closeEditor()
    }
    const blur = () => setFocused(false)
    editor.on('focus', focus)
    editor.on('blur', blur)
    return () => {
      editor.off('focus', focus)
      editor.off('blur', blur)
    }
  }, [editor, closeEditor])

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

  const handleRendered = useCallback(
    (root: SVGSVGElement, renderedTargets: MermaidTarget[]) => {
      setTargets(renderedTargets)
      const targetsById = new Map(renderedTargets.map((target) => [target.domId, target]))
      root.querySelectorAll('[data-mermaid-source-id]').forEach((element) => {
        const target = targetsById.get(element.getAttribute('data-mermaid-source-id') ?? '')
        if (!target || !editing) return
        element.setAttribute('tabindex', '0')
        element.setAttribute('role', 'button')
        element.setAttribute('aria-label', target.label)
        element.setAttribute('data-label-target', '')
        element.addEventListener('click', () => {
          session.current++
          editContext.current = {
            node,
            source,
            remote: store.get(activeRemoteAtom),
            theme,
            anchor: element,
            id: target.id,
          }
          setSelected(target)
          setValidating(false)
          setDraft(target.label)
          setAnchor(element)
          setEditError('')
        })
        element.addEventListener('keydown', (event) => {
          const keyboardEvent = event as KeyboardEvent
          if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
            keyboardEvent.preventDefault()
            element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          }
        })
      })
    },
    [editing, node, source, store, theme],
  )

  useEffect(() => {
    if (!editable || active) {
      setEditing(false)
      closeEditor()
    }
  }, [active, editable, closeEditor])

  const showDiagram = isMermaid && !active && source.trim() !== ''

  useEffect(() => {
    const changed = ({ transaction }: { transaction?: Transaction }) => {
      if (editor.isDestroyed) return
      setEditable(editor.isEditable)
      if (
        editContext.current &&
        (editPosition() === undefined || (transaction?.selectionSet && !transaction.docChanged))
      )
        closeEditor()
    }
    const ownershipChanged = () => {
      if (editContext.current && editPosition() === undefined) closeEditor()
    }
    editor.on('transaction', changed)
    editor.on('update', changed)
    const stopVault = store.sub(activeRemoteAtom, ownershipChanged)
    const stopTheme = store.sub(activeModeAtom, ownershipChanged)
    const observer = new MutationObserver(() => changed({}))
    observer.observe(editor.view.dom, { attributes: true, attributeFilter: ['contenteditable'] })
    return () => {
      observer.disconnect()
      editor.off('transaction', changed)
      editor.off('update', changed)
      stopVault()
      stopTheme()
    }
  }, [editor, editPosition, closeEditor, store])

  useEffect(
    () => () => {
      session.current++
      editContext.current = null
    },
    [],
  )

  async function applyLabel() {
    const context = editContext.current
    if (!selected || !context || selected.id !== context.id) return
    if (editPosition() === undefined) {
      closeEditor()
      return
    }
    const id = session.current
    const capturedSource = context.source
    const capturedId = selected.id
    const capturedDraft = draft
    const patched = patchMermaidLabel(capturedSource, capturedId, capturedDraft)
    if ('error' in patched) {
      setEditError(patched.error)
      return
    }
    if (patched.source === capturedSource) {
      finishEdit()
      return
    }
    const isCurrent = () =>
      session.current === id && editContext.current === context && editPosition() !== undefined
    if (!isCurrent()) {
      closeEditor()
      return
    }
    setValidating(true)
    try {
      const checked = await renderMermaid(patched.source, theme)
      if (!isCurrent()) return
      const livePosition = editPosition()
      if (livePosition === undefined) return
      const oldTargets = new Set(targets.map((target) => target.id))
      const checkedTargets = new Set(checked.targets.map((target) => target.id))
      if (
        oldTargets.size !== checkedTargets.size ||
        [...oldTargets].some((target) => !checkedTargets.has(target)) ||
        !checked.targets.some(
          (target) => target.id === capturedId && target.label === capturedDraft,
        )
      ) {
        setEditError('This label cannot be verified in the rendered diagram. Edit source instead.')
        return
      }
      const change = minimalTextChange(capturedSource, patched.source)
      const transaction = closeHistory(editor.state.tr).insertText(
        change.insert,
        livePosition + 1 + change.from,
        livePosition + 1 + change.to,
      )
      if (
        transaction.selection.from >= livePosition + 1 &&
        transaction.selection.to <=
          livePosition + transaction.doc.nodeAt(livePosition)!.nodeSize - 1
      ) {
        transaction.setSelection(NodeSelection.create(transaction.doc, livePosition))
      }
      closeEditor()
      setEditing(false)
      editor.view.dispatch(transaction)
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.view.focus()
    } catch {
      if (session.current === id)
        setEditError('Could not validate this label. Retry or edit source.')
    } finally {
      if (session.current === id) setValidating(false)
    }
  }

  return (
    <NodeViewWrapper className="tiptap-code-block">
      {showDiagram ? (
        <div className="group/media relative max-w-fit" data-media-root="" contentEditable={false}>
          <RenderedMediaToolbar>
            {editable ? (
              <>
                {targets.length > 0 ? (
                  <RenderedMediaAction
                    onClick={() => {
                      setEditing((value) => !value)
                      closeEditor()
                    }}
                  >
                    {editing ? 'Done' : 'Edit labels'}
                  </RenderedMediaAction>
                ) : null}
                <RenderedMediaAction
                  onClick={() => {
                    const position = currentPosition()
                    if (typeof position === 'number') {
                      editor.commands.setTextSelection(
                        Math.min(position + 1, position + node.nodeSize - 1),
                      )
                      editor.view.focus()
                    }
                  }}
                >
                  Edit source
                </RenderedMediaAction>
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
          <div
            onMouseDown={(event) => {
              if ((event.target as Element).closest('[data-label-target]')) {
                event.preventDefault()
                return
              }
              const position = currentPosition()
              if (editable && typeof position === 'number') {
                event.preventDefault()
                editor.commands.setTextSelection(
                  Math.min(position + 1, position + node.nodeSize - 1),
                )
                editor.view.focus()
              }
            }}
            onDoubleClick={() => setLightboxOpen(true)}
          >
            <MermaidDiagram source={source} theme={theme} onRendered={handleRendered} />
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
      {editing && targets.length === 0 ? (
        <p
          contentEditable={false}
          className="font-sans whitespace-normal text-sm text-muted-foreground"
        >
          Labels cannot be safely edited for this diagram. Edit source instead.
        </p>
      ) : null}
      <MermaidLabelEditor
        target={selected}
        anchor={selected && anchor ? anchor : null}
        draft={draft}
        error={editError}
        validating={validating}
        onDraftChange={(value) => {
          session.current++
          setValidating(false)
          setEditError('')
          setDraft(value)
        }}
        onApply={() => void applyLabel()}
        onCancel={finishEdit}
        onOpenChange={(open) => {
          if (!open) closeEditor()
        }}
      />
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
