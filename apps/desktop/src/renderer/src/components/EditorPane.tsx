import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { openDoc, presenceColor } from '../collab/provider'
import type { MentionData } from '../editor/mentions'
import type { LinkNav } from '../editor/links'
import { baseEditorExtensions } from '../editor/extensions'
import { trpc } from '../lib/trpc'
import { sessionAtom } from '../state/session'
import { syncStatusAtom } from '../state/sync'
import { tasksAtom } from '../state/tasks'
import { activeDocAtom, activeVaultIdAtom, docsAtom } from '../state/vaults'
import { openDocAtom } from '../state/view'

export function EditorPane() {
  const activeDoc = useAtomValue(activeDocAtom)
  const session = useAtomValue(sessionAtom)
  const { docs } = useAtomValue(docsAtom)
  const tasks = useAtomValue(tasksAtom)
  const vaultId = useAtomValue(activeVaultIdAtom)
  const setSyncStatus = useSetAtom(syncStatusAtom)
  const openDocInPane = useSetAtom(openDocAtom)
  const hostRef = useRef<HTMLDivElement>(null)
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(docs.map((d) => d.path))

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
  const navRef = useRef<LinkNav>({ openNote: () => {}, openExternal: () => {} })
  navRef.current = {
    openNote: (path) => {
      const doc = docs.find((d) => d.path === path)
      // A link can point at a note that doesn't exist yet — the chip already renders it
      // as missing, so a click on it should do nothing rather than invent a doc.
      if (doc) openDocInPane(doc)
    },
    openExternal: (url) => void window.holi.openExternal(url),
  }

  useEffect(() => {
    if (!activeDoc || !hostRef.current || !session) return
    let disposed = false
    let view: EditorView | null = null
    let sessionHandle: Awaited<ReturnType<typeof openDoc>> | null = null

    void openDoc(activeDoc.id, setSyncStatus).then((handle) => {
      if (disposed) {
        handle.destroy()
        return
      }
      sessionHandle = handle
      handle.provider.setAwarenessField('user', {
        name: session.name ?? session.email,
        color: presenceColor(session.userId),
      })
      const undoManager = new Y.UndoManager(handle.text)
      view = new EditorView({
        state: EditorState.create({
          doc: handle.text.toString(),
          extensions: [
            ...baseEditorExtensions({
              docExists: (path) => docPaths.current.has(path),
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
            // provider.awareness is typed nullable in v2 but always set with a document
            yCollab(handle.text, handle.provider.awareness!, { undoManager }),
          ],
        }),
        parent: hostRef.current!,
      })
      view.focus()
    })

    return () => {
      disposed = true
      view?.destroy()
      sessionHandle?.destroy()
      setSyncStatus('offline')
    }
  }, [activeDoc, session, setSyncStatus])

  if (!activeDoc) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        select or create a note
      </div>
    )
  }
  return <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />
}
