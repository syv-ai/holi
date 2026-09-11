/**
 * A markdown body editor that is not backed by a file.
 *
 * The new-task dialog needs the notes stack — `@`-mentions, `[[wiki-links]]`
 * that render as chips, live preview — over text that has nowhere to live yet.
 * Every other surface in the app edits a document that exists, which is
 * `EditorPane`'s job; this is the one that does not.
 *
 * Lifted out of `TaskDetail` when the task detail view became the task file
 * itself and the rest of that module went with it.
 */
import type { Task } from '@holi/shared'
import { EditorState } from '@codemirror/state'
import { EditorView, placeholder } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { trpc } from '@/lib/trpc'
import { baseEditorExtensions } from '@/editor/extensions'
import type { LinkNav } from '@/editor/links'
import type { MentionData } from '@/editor/mentions'
import { agentPanelOpenAtom, agentSeedPromptAtom } from '@/state/agent'
import { openNoteTabAtom } from '@/state/panes'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

/**
 * The task description as a full note editor.
 *
 * The description IS the task file's markdown body, so it gets the same editor
 * the notes do — `@`-mentions, `[[wiki-links]]` that render as chips and click
 * through to the note, live preview — rather than a plain textarea. Deps come
 * from the vault snapshot the same pull-based way EditorPane wires them; a
 * wiki-link click opens the note as a tab (`openNoteTabAtom`), switching the
 * view off the board.
 *
 * Mounts once per task (keyed by `task.path` at the call site): the description
 * is last-write-wins with no version, so external edits are not streamed into an
 * open editor — switching tasks remounts with fresh text.
 */
export function TaskDescriptionEditor({
  notePath,
  initial,
  onChange,
  hostClassName,
}: {
  notePath: string
  initial: string
  onChange: (v: string) => void
  /** Override the editor host's classes — the in-pane task editor makes the body
   *  fill the pane, where the sidebar's fixed min-height is right. */
  hostClassName?: string
}): React.JSX.Element {
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const hostRef = useRef<HTMLDivElement>(null)

  // Read on demand so a snapshot arriving mid-edit does not rebuild the view.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshot.tasks.map((t) => [t.path, t]))
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: snapshot.docs.map((d) => ({ path: d.path })),
    tasks: snapshot.tasks.map((t) => ({ path: t.path, title: t.title, status: t.status })),
  }
  /** Same seam the notes editor has (#5): a task's description is prose in the
   *  notes stack, so a passage of it is as askable as a passage of a note. */
  const setAgentSeed = useSetAtom(agentSeedPromptAtom)
  const setAgentOpen = useSetAtom(agentPanelOpenAtom)
  const askAgentRef = useRef<(prompt: string) => void>(() => {})
  askAgentRef.current = (prompt) => {
    setAgentSeed(prompt)
    setAgentOpen(true)
  }
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
            askAgent: (prompt) => askAgentRef.current(prompt),
            notePath,
          }),
          placeholder('description — @ to mention a note, [[wiki-links]] to link'),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      }),
      parent: hostRef.current,
    })
    return () => view.destroy()
    // Mount once; the call site keys this component by task.path so a task
    // switch remounts it with fresh text.

  }, [])

  return (
    <div
      ref={hostRef}
      data-detail-description
      className={
        hostClassName ??
        'mt-1 min-h-[10rem] overflow-hidden rounded-md border border-input bg-transparent text-xs focus-within:border-ring'
      }
    />
  )
}
