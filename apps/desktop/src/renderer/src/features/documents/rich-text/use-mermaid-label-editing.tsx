import { useEditorActivity } from '@/hooks/use-editor-activity'
import { minimalTextChange, patchMermaidLabel } from '@holi/shared'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { useEditorState, type ReactNodeViewProps } from '@tiptap/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { activeRemoteAtom } from '@/state/vaults'
import { activeModeAtom } from '@/state/color-scheme'
import { renderMermaid, type MermaidTarget } from '@/lib/mermaid-renderer'
import { MermaidLabelEditor } from './mermaid-label-editor'

/** Owns label-editing sessions; the diagram node view only requests and displays them. */
export function useMermaidLabelEditing({
  node,
  editor,
  getPos,
  theme,
}: Pick<ReactNodeViewProps, 'node' | 'editor' | 'getPos'> & { theme: 'dark' | 'default' }) {
  const activity = useEditorActivity(editor)
  const draftMemory = useRef<{ source: string; id: string; draft: string } | null>(null)
  const [editable, setEditable] = useState(() => editor.isEditable)
  const [targets, setTargets] = useState<MermaidTarget[]>([])
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<MermaidTarget | null>(null)
  const [anchor, setAnchor] = useState<Element | null>(null)
  const [validating, setValidating] = useState(false)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState('')
  const session = useRef(0)
  const context = useRef<{
    node: typeof node
    source: string
    remote: string | null
    theme: string
    anchor: Element
    id: string
  } | null>(null)
  const store = useStore()
  const source = node.textContent
  const currentPosition = useCallback(
    () => (typeof getPos === 'function' ? getPos() : undefined),
    [getPos],
  )
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const currentPos = currentPosition()
      if (currentPos === undefined) return false
      const { from, to } = current.state.selection
      return (
        current.isEditable &&
        current.view.hasFocus() &&
        from >= currentPos + 1 &&
        to <= currentPos + node.nodeSize - 1
      )
    },
  })
  const close = useCallback(() => {
    session.current++
    context.current = null
    setSelected(null)
    setAnchor(null)
    setEditError('')
    setValidating(false)
  }, [])
  const position = useCallback(() => {
    const current = context.current
    if (
      !current ||
      !activity.focused ||
      editor.isDestroyed ||
      !editor.isEditable ||
      store.get(activeRemoteAtom) !== current.remote ||
      (store.get(activeModeAtom) === 'dark' ? 'dark' : 'default') !== current.theme ||
      !current.anchor.isConnected
    )
      return undefined
    try {
      const currentPos = currentPosition()
      return typeof currentPos === 'number' && editor.state.doc.nodeAt(currentPos) === current.node
        ? currentPos
        : undefined
    } catch {
      return undefined
    }
  }, [currentPosition, editor, store, activity])
  const finish = useCallback(() => {
    const currentPos = position()
    const target = context.current?.anchor
    close()
    if (currentPos !== undefined && target instanceof SVGElement) {
      const { from, to } = editor.state.selection
      const size = editor.state.doc.nodeAt(currentPos)!.nodeSize
      if (from >= currentPos + 1 && to <= currentPos + size - 1)
        editor.commands.setNodeSelection(currentPos)
      target.focus()
    }
  }, [position, close, editor])

  useEffect(() => {
    const focus = () => {
      if (context.current) close()
    }
    editor.on('focus', focus)
    return () => {
      editor.off('focus', focus)
    }
  }, [editor, close])

  useEffect(() => {
    if ((!editable && activity.displayed) || active) {
      setEditing(false)
      close()
    }
  }, [active, editable, close, activity, activity.focused])

  useEffect(() => {
    const changed = ({ transaction }: { transaction?: Transaction }) => {
      if (editor.isDestroyed) return
      setEditable(editor.isEditable)
      if (
        context.current &&
        activity.focused &&
        (position() === undefined || (transaction?.selectionSet && !transaction.docChanged))
      )
        close()
    }
    const ownershipChanged = () => {
      if (context.current && position() === undefined) close()
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
  }, [editor, position, close, store, activity, activity.focused])

  useEffect(
    () => () => {
      session.current++
      context.current = null
    },
    [],
  )

  useEffect(
    () =>
      activity.subscribe(() => {
        if (!activity.focused) {
          session.current++
          setValidating(false)
          setSelected(null)
          setAnchor(null)
        }
      }),
    [activity],
  )

  const onRendered = useCallback(
    (root: SVGSVGElement, renderedTargets: MermaidTarget[]) => {
      setTargets(renderedTargets)
      const targetsById = new Map(renderedTargets.map((target) => [target.domId, target]))
      root.querySelectorAll('[data-mermaid-original-id]').forEach((element) => {
        const target =
          targetsById.get(element.getAttribute('data-mermaid-original-id') ?? '') ??
          targetsById.get(element.getAttribute('data-mermaid-source-id') ?? '')
        if (!target || !editing) return
        element.setAttribute('tabindex', '0')
        element.setAttribute('role', 'button')
        element.setAttribute('aria-label', target.label)
        element.setAttribute('data-label-target', '')
        element.addEventListener('click', () => {
          if (!activity.focused || !editor.isEditable) return
          session.current++
          context.current = {
            node,
            source,
            remote: store.get(activeRemoteAtom),
            theme,
            anchor: element,
            id: target.id,
          }
          setSelected(target)
          setValidating(false)
          const saved = draftMemory.current
          setDraft(saved?.source === source && saved.id === target.id ? saved.draft : target.label)
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
    [editing, node, source, store, theme, activity, editor],
  )

  async function apply() {
    const current = context.current
    if (!selected || !current || selected.id !== current.id) return
    if (position() === undefined) {
      close()
      return
    }
    const currentVisit = activity.capture()
    const sessionId = session.current
    const capturedSource = current.source
    const capturedId = selected.id
    const capturedDraft = draft
    const patched = patchMermaidLabel(capturedSource, capturedId, capturedDraft)
    if ('error' in patched) {
      setEditError(patched.error)
      return
    }
    if (patched.source === capturedSource) {
      finish()
      return
    }
    const isCurrent = () =>
      currentVisit() &&
      session.current === sessionId &&
      context.current === current &&
      position() !== undefined
    if (!isCurrent()) {
      close()
      return
    }
    setValidating(true)
    try {
      const checked = await renderMermaid(patched.source, theme)
      if (!isCurrent()) return
      const livePosition = position()
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
      draftMemory.current = null
      close()
      setEditing(false)
      editor.view.dispatch(transaction)
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.view.focus()
    } catch {
      if (session.current === sessionId)
        setEditError('Could not validate this label. Retry or edit source.')
    } finally {
      if (session.current === sessionId) setValidating(false)
    }
  }

  return {
    targets,
    editing,
    toggleEditing: () => {
      setEditing((value) => !value)
      close()
    },
    onRendered,
    editor: (
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
          if (selected) draftMemory.current = { source, id: selected.id, draft: value }
          setDraft(value)
        }}
        onApply={() => void apply()}
        onCancel={finish}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      />
    ),
  }
}
