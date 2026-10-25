/**
 * A code file's find bar (`find-bar/find-bar.tsx`), driving `code-find.ts`.
 * Typing moves the selection to the first match from where the caret was;
 * Escape closes it and gives the editor back with the match selected.
 */
import { useEffect, useRef, useState } from "react"
import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
} from "@codemirror/search"
import { EditorSelection } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

import {
  EMPTY_FIND_OPTIONS,
  FindBar,
  type FindCount,
  type FindOptions,
  type FindRequest,
} from "../find-bar/find-bar"
import { codeQuery, setCodeQuery } from "./code-find"

export function CodeFindBar({
  view,
  request,
  count,
  onClose,
}: {
  view: EditorView
  request: FindRequest
  /** The editor's count, read again on each of its updates. */
  count: FindCount
  onClose: () => void
}) {
  const [options, setOptions] = useState<FindOptions>({
    ...EMPTY_FIND_OPTIONS,
    search: request.text ?? "",
  })
  const [replacing, setReplacing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the caret was when the bar opened: typing finds from here. */
  const anchor = useRef(view.state.selection.main.from)
  const query = codeQuery(options)

  // Each ⌘F: the selection's line, if any, and the field to type in.
  useEffect(() => {
    anchor.current = view.state.selection.main.from
    if (request.text !== null) {
      const text = request.text
      setOptions((current) => ({ ...current, search: text }))
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [view, request])

  // The query in force follows the bar; a new one selects its first match
  // from the anchor, wrapping, and scrolls to it.
  useEffect(() => {
    setCodeQuery(view, options, true)
    const next = codeQuery(options)
    if (!next.valid) return
    let hit = next.getCursor(view.state, anchor.current).next()
    if (hit.done) hit = next.getCursor(view.state).next()
    if (hit.done) return
    view.dispatch({
      selection: EditorSelection.single(hit.value.from, hit.value.to),
      scrollIntoView: true,
    })
  }, [view, options])

  // Closing clears the highlights.
  useEffect(
    () => () => {
      setCodeQuery(view, EMPTY_FIND_OPTIONS, false)
    },
    [view]
  )

  return (
    <FindBar
      label="Find in file"
      inputRef={inputRef}
      options={options}
      onOptionsChange={(patch) =>
        setOptions((current) => ({ ...current, ...patch }))
      }
      count={count}
      invalid={options.regexp && options.search !== "" && !query.valid}
      editable={!view.state.readOnly}
      replacing={replacing}
      onReplacingChange={setReplacing}
      onNext={() => findNext(view)}
      onPrev={() => findPrevious(view)}
      onReplace={() => replaceNext(view)}
      onReplaceAll={() => replaceAll(view)}
      onClose={() => {
        onClose()
        view.focus()
      }}
    />
  )
}
