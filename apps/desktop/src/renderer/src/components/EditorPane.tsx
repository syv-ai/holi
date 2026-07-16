import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { agentEditingIn, openDoc, presenceColor } from '../collab/provider'
import type { MentionData } from '../editor/mentions'
import type { LinkNav } from '../editor/links'
import { baseEditorExtensions } from '../editor/extensions'
import { trpc } from '../lib/trpc'
import { sessionAtom } from '../state/session'
import { agentEditingAtom, syncStatusAtom } from '../state/sync'
import { resolveRelated, tasksAtom } from '../state/tasks'
import { activeDocAtom, activeVaultIdAtom, docsAtom } from '../state/vaults'
import { openDocAtom, openTaskAtom } from '../state/view'

export function EditorPane() {
  const activeDoc = useAtomValue(activeDocAtom)
  const session = useAtomValue(sessionAtom)
  const { docs } = useAtomValue(docsAtom)
  const tasks = useAtomValue(tasksAtom)
  const vaultId = useAtomValue(activeVaultIdAtom)
  const setSyncStatus = useSetAtom(syncStatusAtom)
  const setAgentEditing = useSetAtom(agentEditingAtom)
  const openDocInPane = useSetAtom(openDocAtom)
  const openTaskInPane = useSetAtom(openTaskAtom)
  const hostRef = useRef<HTMLDivElement>(null)
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(docs.map((d) => d.path))

  // Task-chip titles, resolved through the same join the relations row uses (D57) —
  // including its `[deleted task]` tombstone, so a chip and a relation cannot disagree
  // about whether a task is gone. A ref for the same reason as `mentionRef`: the chip
  // reads it on demand, and rebuilding the view on every task event would drop the caret.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Live mention data + link target, kept fresh each render and read on demand by
  // the pull-based completion source (the editor is built once per open doc).
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: docs.map((d) => ({ path: d.path })),
    tasks: [...tasks.values()].map((t) => ({ id: t.id, title: t.title, status: t.status })),
  }
  const linkRef = useRef<{ vaultId: string | null; docId: string | null }>({
    vaultId: null,
    docId: null,
  })
  linkRef.current = { vaultId, docId: activeDoc?.id ?? null }

  // Clicking a link opens the target (FR-6/FR-7). A ref, not an effect dep: rebuilding
  // the whole EditorView because the doc list changed would drop the caret mid-edit.
  const navRef = useRef<LinkNav>({ openNote: () => {}, openTask: () => {}, openExternal: () => {} })
  navRef.current = {
    openNote: (path) => {
      const doc = docs.find((d) => d.path === path)
      // A link can point at a note that doesn't exist yet — the chip already renders it
      // as missing, so a click on it should do nothing rather than invent a doc.
      if (doc) openDocInPane(doc)
    },
    // Same bargain as openNote: a chip for a deleted task renders as a tombstone, so
    // clicking it does nothing rather than opening an empty detail panel.
    openTask: (id) => {
      if (tasksRef.current.has(id)) openTaskInPane(id)
    },
    openExternal: (url) => void window.holi.openExternal(url),
  }

  useEffect(() => {
    if (!activeDoc || !hostRef.current || !session) return
    let disposed = false
    let view: EditorView | null = null
    let sessionHandle: Awaited<ReturnType<typeof openDoc>> | null = null
    let stopWatchingAgent: (() => void) | null = null

    void openDoc(activeDoc.id, setSyncStatus).then((handle) => {
      if (disposed) {
        handle.destroy()
        return
      }
      sessionHandle = handle
      handle.setUser({
        name: session.name ?? session.email,
        color: presenceColor(session.userId),
      })

      // Main stamps `agentEditing` on its own awareness while a turn writes to this doc
      // (D37); it reaches us across the link (D59). Read it off awareness rather than
      // inventing a second channel — the signal already crosses, it just had no consumer.
      const { awareness } = handle
      const readAgentEditing = (): void =>
        setAgentEditing(agentEditingIn(awareness.getStates(), awareness.clientID))
      awareness.on('change', readAgentEditing)
      stopWatchingAgent = () => awareness.off('change', readAgentEditing)
      // A turn already in flight when we opened the note fires no 'change' of its own.
      readAgentEditing()

      const undoManager = new Y.UndoManager(handle.text)
      view = new EditorView({
        state: EditorState.create({
          doc: handle.text.toString(),
          extensions: [
            ...baseEditorExtensions({
              docExists: (path) => docPaths.current.has(path),
              // `docs` is only consulted for note refs — a task ref resolves against the
              // task map alone.
              taskInfo: (id) => {
                const [ref] = resolveRelated([{ kind: 'task', id }], [], tasksRef.current)
                return { label: ref!.label, missing: ref!.missing }
              },
              mentionData: () => mentionRef.current,
              onTaskMention: (taskId) => {
                const { vaultId: vid, docId } = linkRef.current
                if (!vid || !docId) return
                // Idempotent server-side (D27: note linked by stable doc id, not path).
                void trpc.tasks.link
                  .mutate({ vaultId: vid, taskId, related: { kind: 'note', id: docId } })
                  .catch(() => {})
              },
              nav: () => navRef.current,
            }),
            yCollab(handle.text, handle.awareness, { undoManager }),
          ],
        }),
        parent: hostRef.current!,
      })
      view.focus()
    })

    return () => {
      disposed = true
      stopWatchingAgent?.()
      view?.destroy()
      sessionHandle?.destroy()
      setSyncStatus('offline')
      // The marker is about the doc we're leaving, not the one we're opening.
      setAgentEditing(false)
    }
  }, [activeDoc, session, setSyncStatus, setAgentEditing])

  if (!activeDoc) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        select or create a note
      </div>
    )
  }
  return <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />
}
