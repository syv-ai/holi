import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { openDoc, presenceColor } from '../collab/provider'
import { baseEditorExtensions } from '../editor/extensions'
import { sessionAtom } from '../state/session'
import { syncStatusAtom } from '../state/sync'
import { activeDocAtom, docsAtom } from '../state/vaults'

export function EditorPane() {
  const activeDoc = useAtomValue(activeDocAtom)
  const session = useAtomValue(sessionAtom)
  const { docs } = useAtomValue(docsAtom)
  const setSyncStatus = useSetAtom(syncStatusAtom)
  const hostRef = useRef<HTMLDivElement>(null)
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(docs.map((d) => d.path))

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
            ...baseEditorExtensions((path) => docPaths.current.has(path)),
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
