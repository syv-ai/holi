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
  exportFilesAtom,
  moveNotesAtom,
} from '@/state/vaults'

type DeletePreview = {
  label: string
  /** The vault FILES this affects — what the backrefs were computed over, and
   *  what a delete removes. */
  paths: string[]
  refs: { path: string; count: number }[]
  /**
   * Set when this is a move OUT of the vault: the targets as picked (a folder
   * stays a folder, so it keeps its shape on disk) and where they go.
   *
   * The same dialog serves both because the fallout is the same — links left
   * dangling either way — and only the verb and what happens on confirm differ.
   */
  move?: { targets: string[]; dest: string }
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
  /** Copy targets to a folder on disk. The vault is unchanged. */
  copyOut(targets: string[]): void
  /** Move targets out: confirm first (backrefs), then copy, then delete. */
  startMoveOut(targets: string[], isFolder: boolean): void
  /** The verb the open confirmation is about to apply. */
  confirmVerb: 'Delete' | 'Move'
  /** Files the last export refused, held until dismissed or superseded. */
  exportFailures: { name: string; reason: string }[]
  dismissExportFailures(): void
}

export function useExplorerActions(docPaths: string[]): ExplorerActions {
  const moveNotes = useSetAtom(moveNotesAtom)
  const copyNotes = useSetAtom(copyNotesAtom)
  const deleteMany = useSetAtom(deleteManyAtom)
  const getBackrefs = useSetAtom(backrefsForMany)

  const exportFiles = useSetAtom(exportFilesAtom)

  const [clipboard, setClipboard] = useState<ClipboardData | null>(null)
  const [confirming, setConfirming] = useState<DeletePreview | null>(null)
  const [pendingFolders, setPendingFolders] = useState<string[]>([])
  /** Files the last export refused. Held until dismissed or superseded, for the
   *  same reason the import's are: a file that silently did not arrive is the
   *  worst outcome either direction has. */
  const [exportFailures, setExportFailures] = useState<{ name: string; reason: string }[]>([])

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

  const copyOut = useCallback(
    (targets: string[]) => {
      void (async () => {
        const dest = await window.holi.chooseFolder()
        if (dest === null) return
        const { failed } = await exportFiles(targets, dest)
        setExportFailures(failed)
      })()
    },
    [exportFiles],
  )

  const startMoveOut = useCallback(
    (targets: string[], isFolder: boolean) => {
      void (async () => {
        // The destination is chosen BEFORE the confirmation, so cancelling the
        // confirmation leaves nothing behind — no copy has happened yet.
        const dest = await window.holi.chooseFolder()
        if (dest === null) return
        const files = filesUnder(docPathsRef.current, targets)
        if (files.length === 0) return
        const label = deleteLabel(targets, files.length, isFolder)
        const refs = await getBackrefs(files)
        setConfirming({ label, paths: files, refs, move: { targets, dest } })
      })()
    },
    // No `exportFiles` here on purpose: this only STAGES the move. The copy
    // happens in `confirmDelete`, after the confirmation.
    [getBackrefs],
  )

  const confirmDelete = useCallback(() => {
    const preview = confirmingRef.current
    if (!preview) return
    setConfirming(null)
    if (!preview.move) {
      void deleteMany({ paths: preview.paths })
      return
    }
    const { targets, dest } = preview.move
    void (async () => {
      const { landed, failed } = await exportFiles(targets, dest)
      setExportFailures(failed)
      // ONLY what landed. A target that could not be written is still the only
      // copy there is, and deleting it here would destroy it.
      const survived = new Set(landed.map((l) => l.from))
      const toDelete = filesUnder(
        docPathsRef.current,
        targets.filter((t) => survived.has(t)),
      )
      if (toDelete.length > 0) await deleteMany({ paths: toDelete })
    })()
  }, [deleteMany, exportFiles])

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
    copyOut,
    startMoveOut,
    confirmVerb: confirming?.move ? ('Move' as const) : ('Delete' as const),
    exportFailures,
    dismissExportFailures: () => setExportFailures([]),
  }
}
