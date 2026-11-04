/**
 * The document's find bar (`composites/find-bar.tsx`), driving
 * `document-find.ts`. Typing moves the selection to the first match from
 * where the caret was; Escape closes it and gives the editor back with the
 * match selected.
 */
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { findNext, findPrev, replaceAll, replaceNext, setSearchState } from 'prosemirror-search'

import { useRichTextSelector } from '@/features/documents/rich-text/rich-text-state'

import {
  EMPTY_FIND_OPTIONS,
  FindBar,
  type FindOptions,
  type FindRequest,
} from '../../composites/find-bar'
import { findCount, findQuery } from './document-find'

export type { FindRequest }

export function DocumentFindBar({
  editor,
  request,
  onClose,
}: {
  editor: Editor
  request: FindRequest
  onClose: () => void
}) {
  const [options, setOptions] = useState<FindOptions>({
    ...EMPTY_FIND_OPTIONS,
    search: request.text ?? '',
  })
  const [replacing, setReplacing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the caret was when the bar opened: typing finds from here. */
  const anchor = useRef(editor.state.selection.from)

  const count = useRichTextSelector(editor, (current) =>
    current ? findCount(current.state) : { total: 0, current: null },
  )
  const query = findQuery(options)
  const editable = useRichTextSelector(editor, (current) => current?.isEditable ?? false)

  // Each ⌘F: the selection's line, if any, and the field to type in.
  useEffect(() => {
    anchor.current = editor.state.selection.from
    if (request.text !== null) {
      const text = request.text
      setOptions((current) => ({ ...current, search: text }))
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editor, request])

  // The query in force follows the bar; a new one selects its first match
  // from the anchor, wrapping, and scrolls to it.
  useEffect(() => {
    if (editor.isDestroyed) return
    const { state } = editor
    const next = findQuery(options)
    const tr = setSearchState(state.tr, next)
    if (next.valid) {
      const hit = next.findNext(state, anchor.current) ?? next.findNext(state, 0)
      if (hit) {
        tr.setSelection(TextSelection.create(state.doc, hit.from, hit.to)).scrollIntoView()
      }
    }
    editor.view.dispatch(tr)
  }, [editor, options])

  // Closing clears the highlights.
  useEffect(
    () => () => {
      if (editor.isDestroyed) return
      editor.view.dispatch(setSearchState(editor.state.tr, findQuery({ ...EMPTY_FIND_OPTIONS })))
    },
    [editor],
  )

  const run = (command: typeof findNext) => command(editor.state, editor.view.dispatch)

  return (
    <FindBar
      label="Find in document"
      inputRef={inputRef}
      options={options}
      onOptionsChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
      count={count}
      invalid={options.regexp && options.search !== '' && !query.valid}
      editable={editable}
      replacing={replacing}
      onReplacingChange={setReplacing}
      onNext={() => run(findNext)}
      onPrev={() => run(findPrev)}
      onReplace={() => run(replaceNext)}
      onReplaceAll={() => run(replaceAll)}
      onClose={() => {
        onClose()
        editor.commands.focus()
      }}
    />
  )
}
