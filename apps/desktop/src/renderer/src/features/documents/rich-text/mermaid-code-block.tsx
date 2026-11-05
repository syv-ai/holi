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
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { useStore } from 'jotai'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { activeRemoteAtom } from '@/state/vaults'
import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const inputId = useId()
  const [editable, setEditable] = useState(() => editor.isEditable)
  const [svg, setSvg] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
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
  const svgHost = useRef<HTMLDivElement>(null)
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
      !svgHost.current?.isConnected ||
      !svgHost.current.contains(context.anchor)
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
  }, [active, isMermaid, source, theme, retry])

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
    const liveRoot = document.importNode(root, true)
    host.replaceChildren(liveRoot)
    const targetsById = new Map(targets.map((target) => [target.domId, target]))
    liveRoot.querySelectorAll('[id]').forEach((targetEl) => {
      const target = targetsById.get(targetEl.id)
      if (!target || !editing) return
      targetEl.setAttribute('tabindex', '0')
      targetEl.setAttribute('role', 'button')
      targetEl.setAttribute('aria-label', `${target.label} (${target.id})`)
      targetEl.setAttribute('data-label-target', '')
      targetEl.addEventListener('click', () => {
        session.current++
        editContext.current = {
          node,
          source,
          remote: store.get(activeRemoteAtom),
          theme,
          anchor: targetEl,
          id: target.id,
        }
        setSelected(target)
        setValidating(false)
        setDraft(target.label)
        setAnchor(targetEl)
        setEditError('')
      })
      targetEl.addEventListener('keydown', (event) => {
        const key = (event as KeyboardEvent).key
        if (key === 'Enter' || key === ' ') {
          event.preventDefault()
          targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
      })
    })
  }, [editing, svg, targets, node, source, store, theme])

  useEffect(() => {
    if (!editable || active) {
      setEditing(false)
      closeEditor()
    }
  }, [active, editable, closeEditor])

  const showDiagram = isMermaid && !active && source.trim() !== '' && !renderError

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
      const old = capturedSource
      const next = patched.source
      let start = 0
      while (start < old.length && old[start] === next[start]) start++
      let end = 0
      while (end < old.length - start && old[old.length - 1 - end] === next[next.length - 1 - end])
        end++
      const transaction = closeHistory(editor.state.tr).insertText(
        next.slice(start, next.length - end),
        livePosition + 1 + start,
        livePosition + 1 + old.length - end,
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
        <div
          ref={svgHost}
          data-mermaid-diagram=""
          contentEditable={false}
          role={editing ? 'group' : svg ? 'img' : 'status'}
          aria-label={
            editing ? 'Editable Mermaid diagram' : svg ? 'Mermaid diagram' : 'Rendering diagram'
          }
          onMouseDown={(event) => {
            if ((event.target as Element).closest('[data-label-target]')) {
              event.preventDefault()
              return
            }
            const position = currentPosition()
            if (editable && typeof position === 'number') {
              event.preventDefault()
              editor.commands.setTextSelection(Math.min(position + 1, position + node.nodeSize - 1))
              editor.view.focus()
            }
          }}
        >
          {svg ? null : (
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-sm">Rendering diagram…</span>
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </div>
      ) : null}
      {showDiagram && editable ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing((value) => !value)
              closeEditor()
            }}
          >
            {editing ? 'Done' : 'Edit labels'}
          </Button>
          <Button
            type="button"
            size="sm"
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
      {editing && svg && targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Labels cannot be safely edited for this diagram. Edit source instead.
        </p>
      ) : null}
      <Popover
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) closeEditor()
        }}
      >
        {selected && anchor ? (
          <PopoverAnchor
            virtualRef={{
              current: { getBoundingClientRect: () => anchor.getBoundingClientRect() },
            }}
          />
        ) : null}
        <PopoverContent
          onEscapeKeyDown={finishEdit}
          onInteractOutside={closeEditor}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {selected ? (
            <div
              className="flex flex-col gap-2"
              role="group"
              aria-label={`Edit ${selected.id} label`}
            >
              <Label htmlFor={inputId}>
                {selected.label} ({selected.id})
              </Label>
              <Input
                id={inputId}
                value={draft}
                aria-invalid={Boolean(editError)}
                aria-describedby={editError ? `${inputId}-error` : undefined}
                onChange={(event) => {
                  session.current++
                  setValidating(false)
                  setEditError('')
                  setDraft(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') finishEdit()
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void applyLabel()
                  }
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={validating}
                  onClick={() => void applyLabel()}
                >
                  Apply
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={finishEdit}>
                  Cancel
                </Button>
              </div>
              {editError ? (
                <p id={`${inputId}-error`} role="alert">
                  {editError}
                </p>
              ) : null}
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <NodeViewContent
        className={showDiagram ? 'hidden' : undefined}
        data-mermaid-source={isMermaid ? '' : undefined}
      />
      {renderError && isMermaid ? (
        <div role="status" className="flex gap-2 text-sm">
          <span>Couldn&apos;t draw this diagram.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setRenderError(false)
              setSvg(null)
              setRetry((value) => value + 1)
            }}
          >
            Retry
          </Button>
          <Button
            type="button"
            size="sm"
            variant="text"
            onClick={() => {
              const position = currentPosition()
              if (typeof position === 'number') editor.commands.setTextSelection(position + 1)
            }}
          >
            Edit source
          </Button>
        </div>
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
