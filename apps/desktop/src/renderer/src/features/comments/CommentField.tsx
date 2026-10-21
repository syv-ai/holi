/**
 * A comment's text field, for the panel's composer and reply: a small
 * CodeMirror view so `@` completes the vault's people in the same popup as
 * the notes editor's `@` (`editor/member-mentions.ts`).
 *
 * The view is built once and never from `value`: a field rebuilt on each
 * keystroke would lose the caret and the undo history. Clearing after a send
 * is done through the handle.
 */
import { sameLogin } from '@holi/shared'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useAtomValue } from 'jotai'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { commentFieldExtensions } from '@/editor/extensions'
import { cn } from '@/lib/cn'
import { TEXT_FIELD_LOOK } from '@/primitives'
import { memberLoginsAtom } from '@/state/members'
import { sessionAtom } from '@/state/session'

export interface CommentFieldHandle {
  clear: () => void
}

export function CommentField({
  label,
  placeholder,
  autoFocus = false,
  ref,
  ...on
}: {
  label: string
  placeholder: string
  autoFocus?: boolean
  onChange: (body: string) => void
  onSubmit: () => void
  onCancel?: () => void
  ref?: Ref<CommentFieldHandle>
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // Read through refs: the view outlives a render, its callbacks must not.
  const handlers = useRef(on)
  handlers.current = on
  // Everyone but the person writing: a comment tags someone else.
  const members = useAtomValue(memberLoginsAtom)
  const me = useAtomValue(sessionAtom)?.login ?? null
  const others = useRef<string[]>([])
  others.current = members.filter((login) => me === null || !sameLogin(login, me))
  const initial = useRef({ placeholder, autoFocus, label, cancels: on.onCancel !== undefined })

  useEffect(() => {
    const parent = host.current
    if (parent === null) return
    const v = new EditorView({
      state: EditorState.create({
        extensions: [
          ...commentFieldExtensions({
            logins: () => others.current,
            placeholder: initial.current.placeholder,
            submit: () => handlers.current.onSubmit(),
            ...(initial.current.cancels ? { cancel: () => handlers.current.onCancel?.() } : {}),
          }),
          EditorView.contentAttributes.of({
            'aria-label': initial.current.label,
            'aria-multiline': 'true',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
      parent,
    })
    view.current = v
    if (initial.current.autoFocus) v.focus()
    return () => {
      view.current = null
      v.destroy()
    }
  }, [])

  useImperativeHandle(ref, () => ({
    clear: () => {
      const v = view.current
      if (v === null) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } })
    },
  }))

  return (
    <div
      ref={host}
      data-comment-field=""
      className={cn(TEXT_FIELD_LOOK, 'min-h-12 cursor-text px-3 py-2')}
      onClick={() => view.current?.focus()}
    />
  )
}
