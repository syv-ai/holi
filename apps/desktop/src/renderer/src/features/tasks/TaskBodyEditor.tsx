/**
 * A markdown body editor that is not backed by a file.
 *
 * The new-task dialog needs the notes stack (`@`-mentions, `[[wiki-links]]`
 * that render as chips, live preview) over text that has nowhere to live yet.
 * Every other surface edits a document that exists, which is `EditorPane`'s job.
 */
import { snapshotTasks, type Task } from '@holi/shared'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, placeholder } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { trpc } from '@/lib/trpc'
import { baseEditorExtensions } from '@/editor/extensions'
import type { LinkNav } from '@/editor/links'
import type { MentionData } from '@/editor/mentions'
import { NO_AGENT, useAskAgentSeam } from '@/state/agent-service'
import { openNoteTabAtom } from '@/state/panes'
import { memberLoginsAtom } from '@/state/members'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

/**
 * The task description as a full note editor rather than a plain textarea.
 * Deps come from the vault snapshot the same pull-based way EditorPane wires
 * them; a wiki-link click opens the note as a tab (`openNoteTabAtom`).
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
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const hostRef = useRef<HTMLDivElement>(null)

  // Read on demand so a snapshot arriving mid-edit does not rebuild the view.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshotTasks(snapshot).items.map((t) => [t.path, t]))
  const people = useAtomValue(memberLoginsAtom)
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: snapshot.docs.map((d) => ({
      path: d.path,
      ...(snapshot.icons[d.path] === undefined ? {} : { icon: snapshot.icons[d.path] }),
    })),
    tasks: snapshotTasks(snapshot).items.map((t) => ({
      path: t.path,
      title: t.title,
      status: t.status,
      ...(t.due === undefined ? {} : { due: t.due }),
    })),
    people,
  }
  /** Same Ask agent seam the notes editor has: a passage of a task's
   *  description is as askable as a passage of a note. The view is built once,
   *  so whether there is an agent is decided then. */
  const askAgent = useAskAgentSeam()
  const askAgentRef = useRef(askAgent)
  askAgentRef.current = askAgent
  const navRef = useRef<LinkNav>({ openNote: () => {}, openExternal: () => {} })
  navRef.current = {
    openNote: (target) =>
      (docPaths.current.has(target) || tasksByPath.current.has(target)) && openNote(target),
    openExternal: (url) => void window.holi.openExternal(url),
  }
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (hostRef.current === null) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          ...baseEditorExtensions({
            docExists: (p) => docPaths.current.has(p),
            taskByPath: (p) => {
              const t = tasksByPath.current.get(p)
              return t ? { title: t.title, status: t.status, due: t.due } : null
            },
            readNote: (p) =>
              remote === null
                ? Promise.resolve(null)
                : trpc.notes.read.query({ remote, path: p }).then(
                    (text) => text,
                    () => null,
                  ),
            mentionData: () => mentionRef.current,
            nav: () => navRef.current,
            ...(askAgentRef.current === null
              ? {}
              : {
                  askAgent: {
                    targets: () =>
                      askAgentRef.current?.targets() ?? { sessions: [], initial: 'new' },
                    onAsk: (prompt, target) =>
                      askAgentRef.current?.onAsk(prompt, target) ?? Promise.resolve(NO_AGENT),
                  },
                }),
            notePath,
            frontmatter: false,
          }),
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
