/**
 * The explorer's mutation layer, lifted out of the FileTree view. Owns the state
 * adjacent to mutations — the cut/copy clipboard, the delete-confirm preview, and
 * the transient (empty, not-yet-on-disk) folders — and turns the pure plans from
 * `lib/tree-actions` into batch-atom dispatches. FileTree keeps only projection +
 * headless-tree wiring + render; every "what files move where" decision is here,
 * planned by pure functions that are unit-tested directly (see tree-actions.test).
 *
 * Method identities are stable (useCallback with no deps) and read the freshest
 * doc-path set / clipboard / preview through refs, because headless-tree captures
 * its hotkey-handler closures exactly once.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import {
  type ClipboardData,
  deleteLabel,
  filesUnder,
  planDuplicate,
  planMoveInto,
  planPaste,
  planRenameFolder,
} from '@/lib/tree-actions'
import {
  backrefsForMany,
  copyNotesAtom,
  deleteManyAtom,
  moveNotesAtom,
} from '@/state/vaults'

type DeletePreview = {
  label: string
  paths: string[]
  refs: { path: string; count: number }[]
}

export interface ExplorerActions {
  /** Non-null while a cut/copy is staged; a cut dims its rows until pasted. */
  clipboard: ClipboardData | null
  /** Non-null while the delete-preview dialog is open. */
  confirming: DeletePreview | null
  /** Transient folders that exist only client-side until a note lands inside. */
  pendingFolders: string[]
  cut(paths: string[]): void
  copy(paths: string[]): void
  moveInto(sources: string[], destFolder: string): void
  paste(destFolder: string): void
  duplicate(targets: string[]): void
  renameFolder(folder: string, newName: string): void
  startDelete(targets: string[], isFolder: boolean): void
  cancelDelete(): void
  confirmDelete(): void
  addPendingFolder(path: string): void
}

export function useExplorerActions(docPaths: string[]): ExplorerActions {
  const moveNotes = useSetAtom(moveNotesAtom)
  const copyNotes = useSetAtom(copyNotesAtom)
  const deleteMany = useSetAtom(deleteManyAtom)
  const getBackrefs = useSetAtom(backrefsForMany)

  const [clipboard, setClipboard] = useState<ClipboardData | null>(null)
  const [confirming, setConfirming] = useState<DeletePreview | null>(null)
  const [pendingFolders, setPendingFolders] = useState<string[]>([])

  // headless-tree captures handler closures once; refs keep the stable methods
  // below reading the latest values.
  const docPathsRef = useRef(docPaths)
  docPathsRef.current = docPaths
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard
  const confirmingRef = useRef(confirming)
  confirmingRef.current = confirming

  // A transient folder becomes real once the snapshot carries a note inside it.
  useEffect(() => {
    setPendingFolders((f) => f.filter((folder) => !docPaths.some((p) => p.startsWith(`${folder}/`))))
  }, [docPaths])

  const cut = useCallback((paths: string[]) => setClipboard({ mode: 'cut', paths }), [])
  const copy = useCallback((paths: string[]) => setClipboard({ mode: 'copy', paths }), [])

  const moveInto = useCallback((sources: string[], destFolder: string) => {
    const moves = planMoveInto(docPathsRef.current, sources, destFolder)
    if (moves.length) void moveNotes({ moves })
  }, [moveNotes])

  const paste = useCallback(
    (destFolder: string) => {
      const clip = clipboardRef.current
      if (!clip) return
      const plan = planPaste(docPathsRef.current, clip, destFolder)
      if (plan.mode === 'move') {
        if (plan.moves.length) void moveNotes({ moves: plan.moves })
        setClipboard(null) // a cut is consumed; a copy stays for repeat paste.
      } else if (plan.copies.length) {
        void copyNotes({ copies: plan.copies })
      }
    },
    [moveNotes, copyNotes],
  )

  const duplicate = useCallback(
    (targets: string[]) => {
      const copies = planDuplicate(docPathsRef.current, targets)
      if (copies.length) void copyNotes({ copies })
    },
    [copyNotes],
  )

  const renameFolder = useCallback(
    (folder: string, newName: string) => {
      const { dest, files, moves } = planRenameFolder(docPathsRef.current, folder, newName)
      if (dest === folder) return
      if (files.length === 0) {
        // A transient (empty) folder: rename it client-side, nothing on disk yet.
        setPendingFolders((f) => f.map((x) => (x === folder ? dest : x)))
        return
      }
      if (moves.length) void moveNotes({ moves })
    },
    [moveNotes],
  )

  const startDelete = useCallback(
    (targets: string[], isFolder: boolean) => {
      const files = filesUnder(docPathsRef.current, targets)
      if (files.length === 0) {
        // Nothing on disk — a transient (empty) folder; just drop it from pending.
        setPendingFolders((f) => f.filter((x) => !targets.includes(x)))
        return
      }
      const label = deleteLabel(targets, files.length, isFolder)
      void getBackrefs(files).then((refs) => setConfirming({ label, paths: files, refs }))
    },
    [getBackrefs],
  )

  const cancelDelete = useCallback(() => setConfirming(null), [])
  const confirmDelete = useCallback(() => {
    const preview = confirmingRef.current
    if (!preview) return
    setConfirming(null)
    void deleteMany({ paths: preview.paths })
  }, [deleteMany])

  const addPendingFolder = useCallback(
    (path: string) => setPendingFolders((f) => [...f, path]),
    [],
  )

  return {
    clipboard,
    confirming,
    pendingFolders,
    cut,
    copy,
    moveInto,
    paste,
    duplicate,
    renameFolder,
    startDelete,
    cancelDelete,
    confirmDelete,
    addPendingFolder,
  }
}
