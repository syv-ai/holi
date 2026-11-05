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
import { useCallback, useEffect, useRef, useState } from 'react'
import { closeHistory } from '@tiptap/pm/history'
import { useStore } from 'jotai'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { activeRemoteAtom } from '@/state/vaults'
import { useAtomValue } from 'jotai'

import { activeModeAtom } from '@/state/color-scheme'

function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  // Surface plan: operational document surface; record-detail/editor archetype; no added frame/card; dense actions, default field; drawing actions then anchored label field; empty-source fallback, render skeleton and inline error/retry; no new motion.
  const [svg, setSvg] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [focused, setFocused] = useState(() => editor.view.hasFocus())
  const [targets, setTargets] = useState<MermaidTarget[]>([])
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<MermaidTarget | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [validating, setValidating] = useState(false)
  const session = useRef(0)
  const editContext = useRef<{
    node: typeof node
    source: string
    remote: string | null
    theme: string
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState('')
  const activeMode = useAtomValue(activeModeAtom)
  const store = useStore()
  const theme = activeMode === 'dark' ? 'dark' : 'default'
  const svgHost = useRef<HTMLDivElement>(null)
  const source = node.textContent
  const isMermaid = String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  const editable = editor.isEditable
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
        editContext.current = { node, source, remote: store.get(activeRemoteAtom), theme }
        setSelected(target)
        setDraft(target.label)
        setAnchor(targetEl as HTMLElement)
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
    const invalidateIfDeparted = () => {
      if (!selected) return
      let position: number | undefined
      try {
        position = currentPosition()
      } catch {
        closeEditor()
        return
      }
      const context = editContext.current
      const liveNode = typeof position === 'number' ? editor.state.doc.nodeAt(position) : null
      const { from, to } = editor.state.selection
      if (
        !editor.isEditable ||
        !context ||
        !liveNode?.eq(context.node) ||
        liveNode.textContent !== context.source ||
        store.get(activeRemoteAtom) !== context.remote ||
        context.theme !== theme ||
        from < (position ?? 0) ||
        to > (position ?? 0) + (liveNode?.nodeSize ?? 0)
      )
        closeEditor()
    }
    editor.on('transaction', invalidateIfDeparted)
    editor.on('update', invalidateIfDeparted)
    return () => {
      editor.off('transaction', invalidateIfDeparted)
      editor.off('update', invalidateIfDeparted)
    }
  }, [editor, selected, closeEditor, store, activeMode, theme, currentPosition])

  useEffect(
    () => () => {
      session.current++
      editContext.current = null
    },
    [],
  )

  async function applyLabel() {
    const context = editContext.current
    if (!selected || !context || !editable || !editor.isEditable) return
    const id = session.current
    const capturedSource = context.source
    const capturedNode = context.node
    const capturedId = selected.id
    const remote = context.remote
    const capturedDraft = draft
    const patched = patchMermaidLabel(capturedSource, capturedId, capturedDraft)
    if ('error' in patched) {
      setEditError(patched.error)
      return
    }
    if (patched.source === capturedSource) {
      closeEditor()
      return
    }
    const isCurrent = () => {
      if (session.current !== id || !editor.isEditable || store.get(activeRemoteAtom) !== remote)
        return false
      try {
        const position = currentPosition()
        return (
          typeof position === 'number' &&
          editor.state.doc.nodeAt(position)?.eq(capturedNode) === true &&
          editor.state.doc.nodeAt(position)?.textContent === capturedSource &&
          context.theme === theme &&
          svgHost.current?.isConnected === true
        )
      } catch {
        return false
      }
    }
    if (!isCurrent()) {
      closeEditor()
      return
    }
    setValidating(true)
    try {
      const checked = await renderMermaid(patched.source, theme)
      if (!isCurrent()) return
      const livePosition = currentPosition()
      if (
        session.current !== id ||
        !editor.isEditable ||
        typeof livePosition !== 'number' ||
        editor.state.doc.nodeAt(livePosition)?.eq(capturedNode) !== true ||
        editor.state.doc.nodeAt(livePosition)?.textContent !== capturedSource ||
        store.get(activeRemoteAtom) !== remote ||
        !svgHost.current?.isConnected
      )
        return
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
      const before = closeHistory(editor.state.tr)
      editor.view.dispatch(before)
      const transaction = editor.state.tr.insertText(
        next.slice(start, next.length - end),
        livePosition + 1 + start,
        livePosition + 1 + old.length - end,
      )
      editor.view.dispatch(closeHistory(transaction))
      closeEditor()
      setEditing(false)
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
      {editing && targets.length === 0 ? (
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
        <PopoverContent onEscapeKeyDown={closeEditor} onInteractOutside={closeEditor}>
          {selected ? (
            <div
              className="flex flex-col gap-2"
              role="group"
              aria-label={`Edit ${selected.id} label`}
            >
              <Label htmlFor="mermaid-label-input">
                {selected.label} ({selected.id})
              </Label>
              <Input
                id="mermaid-label-input"
                value={draft}
                onChange={(event) => {
                  session.current++
                  setValidating(false)
                  setDraft(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeEditor()
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
                <Button type="button" size="sm" variant="outline" onClick={closeEditor}>
                  Cancel
                </Button>
              </div>
              {editError ? <p role="alert">{editError}</p> : null}
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
