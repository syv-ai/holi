/**
 * A markdown body editor that is not backed by a file.
 *
 * The new-task dialog needs the notes stack (`@`-mentions, `[[wiki-links]]`
 * that render as chips, live preview) over text that has nowhere to live yet.
 * Every other surface edits a document that exists, which is `EditorPane`'s job.
 */
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, placeholder } from '@codemirror/view'
import { useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { baseEditorExtensions, openNoteTabAtom, useEditorDeps } from '@/plugin-api'

/**
 * The task description as a full note editor rather than a plain textarea.
 * Its seams are the notes editor's (`useEditorDeps`); a wiki-link click opens
 * the note as a tab (`openNoteTabAtom`).
 *
 * Mounts once: `initial` is read at mount only, and nothing is streamed into
 * an open editor.
 */
export function TaskDescriptionEditor({
  notePath,
  initial,
  onChange,
  hostClassName,
  placeholderText = 'description — @ to mention a note, [[wiki-links]] to link',
  extensions = [],
  viewRef,
}: {
  notePath: string
  initial: string
  onChange: (v: string) => void
  /** Override the editor host's default classes (a fixed min-height). */
  hostClassName?: string
  placeholderText?: string
  /** A host's own layer over the notes stack (quick add's keys and title line),
   *  read at mount like `initial`. */
  extensions?: Extension[]
  /** The live view, for a host that moves focus into it. */
  viewRef?: React.RefObject<EditorView | null>
}): React.JSX.Element {
  const openNote = useSetAtom(openNoteTabAtom)
  const hostRef = useRef<HTMLDivElement>(null)
  /** The notes editor's seams, the Ask seam among them: a passage of a
   *  task's description is as askable as a passage of a note. The view is
   *  built once, so whether there is an agent is decided then. */
  const deps = useEditorDeps(notePath, { openNote })
  const depsRef = useRef(deps)
  depsRef.current = deps
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (hostRef.current === null) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          ...baseEditorExtensions({ ...depsRef.current, frontmatter: false }),
          ...extensions,
          placeholder(placeholderText),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      }),
      parent: hostRef.current,
    })
    if (viewRef) viewRef.current = view
    return () => {
      if (viewRef) viewRef.current = null
      view.destroy()
    }
    // Mount once; `initial` seeds the view and is not tracked afterwards.
  }, [])

  return (
    <div
      ref={hostRef}
      data-detail-description
      className={hostClassName ?? 'mt-1 min-h-[10rem] overflow-hidden rounded-md bg-muted text-xs'}
    />
  )
}
