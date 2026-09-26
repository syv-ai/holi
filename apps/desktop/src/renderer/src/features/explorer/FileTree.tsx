/**
 * The vault as a VS Code-style explorer (docs/features/file-tree.md).
 *
 * Pure projection of `snapshotAtom` (plus the client-only transient folders the
 * action hook owns). headless-tree owns selection/focus/expansion/keyboard; every
 * mutation runs through `useExplorerActions`, which plans the batch atoms.
 */
import {
  dragAndDropFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type TreeInstance,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { fileKind, ICONS_FILE, isAppRootPath, isHiddenPath, isLocalOnlyPath } from '@holi/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useArrivals } from '@/lib/use-arrivals'
import { cn } from '@/lib/cn'
import { pendingSlot } from '@/lib/pending-slot'
import { todayDailyPathAtom } from '@/state/daily'
import { todayLinkCountAtom } from '@/state/tasks'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  Input,
} from '@/primitives'
import { DeleteConfirm } from '@/composites'
import { ExplorerHeader } from './ExplorerHeader'
import { AppFolderIcon, ChevronIcon, FolderIcon, MarkdownIcon, TaskIcon } from './icons'
import { fileIconFor } from '@/composites/file-icons'
import { useExplorerActions } from './useExplorerActions'
import { buildTreeData, ROOT_ID, type TreeItemData } from '@/lib/tree-data'
import {
  ancestorsOf,
  joinPath,
  parentOf,
  renameBasenameRange,
  withMdExtension,
} from '@/lib/tree-paths'
import {
  activeRemoteAtom,
  createFolderAtom,
  createNoteAtom,
  importFilesAtom,
  renameNoteAtom,
  showHiddenByVaultAtom,
  showTasksByVaultAtom,
  snapshotAtom,
  vaultsAtom,
} from '@/state/vaults'
import { openDialogAtom } from '@/state/dialogs'
import { revealRequestAtom } from '@/state/reveal'

/** The inline editable row shown when creating a file or folder. */
function PendingRow({
  kind,
  level,
  onCommit,
  onCancel,
}: {
  kind: 'file' | 'folder'
  /** Tree depth, so the input lines up with the children it is about to join. */
  level: number
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  return (
    <div
      className="flex h-[22px] items-center gap-1 pr-2"
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
        {kind === 'folder' ? <FolderIcon /> : <MarkdownIcon />}
      </span>
      <Input
        autoFocus
        className="h-[22px] flex-1 rounded border-primary bg-background px-1 py-0 text-sm shadow-none"
        placeholder={kind === 'folder' ? 'folder name' : 'note name'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && value.trim()) onCommit(value.trim())
        }}
        onBlur={onCancel}
      />
    </div>
  )
}

export function FileTree({
  activePath,
  onOpenPreview,
  onOpenPinned,
  onOpenInNewPane,
  onTryNavTree,
}: {
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
  /** Open the file beside the current pane rather than in it. */
  onOpenInNewPane: (path: string) => void
  /** Swaps in the `NavTree` experiment. */
  onTryNavTree?: () => void
}) {
  const snapshot = useAtomValue(snapshotAtom)
  const todayDailyPath = useAtomValue(todayDailyPathAtom)
  const todayLinkCount = useAtomValue(todayLinkCountAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const [showHiddenByVault, setShowHiddenByVault] = useAtom(showHiddenByVaultAtom)
  // Per-vault "show hidden files" flag; a vault never toggled defaults to hidden.
  const showHidden = activeRemote !== null && showHiddenByVault[activeRemote] === true
  const toggleHidden = () => {
    if (activeRemote === null) return
    setShowHiddenByVault({ ...showHiddenByVault, [activeRemote]: !showHidden })
  }
  const [showTasksByVault, setShowTasksByVault] = useAtom(showTasksByVaultAtom)
  // Per-vault "show task files in the tree" flag; off unless a vault opts in.
  const showTasks = activeRemote !== null && showTasksByVault[activeRemote] === true
  const toggleTasks = () => {
    if (activeRemote === null) return
    setShowTasksByVault({ ...showTasksByVault, [activeRemote]: !showTasks })
  }
  const renameNote = useSetAtom(renameNoteAtom)
  const importDropped = useSetAtom(importFilesAtom)
  const createNote = useSetAtom(createNoteAtom)
  const createFolder = useSetAtom(createFolderAtom)
  const openDialog = useSetAtom(openDialogAtom)

  const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)
  /** A drag from outside the app is over the tree. */
  const [importing, setImporting] = useState(false)
  /** Files the last drop refused, held until the next one. A file that silently
   *  did not arrive is the worst outcome of an import, so this is not a toast:
   *  it stays until it is dismissed or superseded. */
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([])
  /** Folder ids, for deciding where a dropped file lands. */
  const dirSet = useMemo(() => new Set(snapshot.dirs), [snapshot.dirs])

  // The tree projects notes AND non-markdown files; the scanner keeps them in
  // separate lists so link-aware ops stay markdown-only. Task files join only
  // when the per-vault toggle is on, since the board owns them by default
  // (docs/features/file-tree.md).
  const docPaths = useMemo(
    () => [
      ...snapshot.docs.map((d) => d.path),
      ...snapshot.files.map((f) => f.path),
      ...(showTasks ? snapshot.tasks.map((t) => t.path) : []),
    ],
    [snapshot, showTasks],
  )
  // Task-by-path, so a task leaf can show a status glyph and strike a done name.
  const taskByPath = useMemo(() => new Map(snapshot.tasks.map((t) => [t.path, t])), [snapshot])

  // One source: `.holi/settings/icons.yaml`, which covers a note, a folder and a binary
  // alike. A note's frontmatter is deliberately not a second one (D82).
  const iconByPath = useMemo(() => new Map(Object.entries(snapshot.icons)), [snapshot.icons])

  const actions = useExplorerActions(docPaths)

  const revealRequest = useAtomValue(revealRequestAtom)
  const revealPath = revealRequest?.path ?? null

  // Hidden entries are filtered out unless the per-vault toggle is on. "Hidden"
  // means dot-prefixed (`.holi/…`) OR machine-local (`*.local.*`, e.g.
  // `USER.local.md`, not dot-prefixed but still gated by the toggle).
  const data = useMemo(() => {
    // A revealed path outranks the filter, for that one path only: Edit Source
    // reveals `.holi/apps/<id>/index.html`, hidden in most vaults. Flipping
    // `showHiddenByVault` instead would change the whole explorer for one menu
    // click. `buildTreeData` grows the ancestor folders from the path, so only
    // that branch appears.
    const visible = showHidden
      ? docPaths
      : docPaths.filter((p) => p === revealPath || (!isHiddenPath(p) && !isLocalOnlyPath(p)))
    // Real on-disk folders shown in their own right, so a folder appears even when
    // its whole content is filtered away above (only tasks, only hidden files) or
    // it is empty but for a `.gitkeep`. Hidden dirs (`.holi/…`) stay gated by the
    // same toggle. `pendingFolders` are the still-being-named client-only ones.
    const dirs = showHidden ? snapshot.dirs : snapshot.dirs.filter((d) => !isHiddenPath(d))
    return buildTreeData(visible, [...dirs, ...actions.pendingFolders])
  }, [docPaths, snapshot.dirs, actions.pendingFolders, showHidden, revealPath])

  /**
   * What git ignores, so the tree can dim it. The name does not tell you:
   * `*.local.*` is only the seeded rule and a vault may ignore anything. Main
   * answers with `git check-ignore` and carries it on the snapshot, so the
   * renderer never keeps a rule in step with git.
   */
  const ignoredSet = useMemo(() => new Set(snapshot.ignored), [snapshot.ignored])

  // headless-tree captures config closures once; this ref keeps the loaders
  // reading the latest projection.
  const dataRef = useRef(data)
  dataRef.current = data

  /** The last reveal actually carried out — see the reveal effect below. */
  const revealedNonce = useRef<number | null>(null)

  // Selection-aware target set from a tree instance: the whole multi-selection
  // when the focused/clicked row is part of it, else just that one row (VS Code).
  const targetsFrom = (t: TreeInstance<TreeItemData>, clickedId?: string): string[] => {
    const sel = t.getSelectedItems().map((i) => i.getId())
    if (clickedId !== undefined)
      return sel.length > 1 && sel.includes(clickedId) ? sel : [clickedId]
    const focused = t.getFocusedItem()?.getId()
    if (sel.length > 1 && focused && sel.includes(focused)) return sel
    return focused ? [focused] : sel
  }

  // The folder a paste/new-in lands in for a tree instance: the focused folder
  // itself, or the parent of the focused file, or root.
  const destFolderFrom = (t: TreeInstance<TreeItemData>): string => {
    const f = t.getFocusedItem()
    if (!f) return ''
    return f.isFolder() ? (f.getId() === ROOT_ID ? '' : f.getId()) : parentOf(f.getId())
  }

  // A drop carrying OS files, wherever it lands. Behind a ref for the same
  // reason `dataRef` is: headless-tree captures the config closures once, and
  // this one reads `entry` and the action hook, both of which change per render.
  const dropFilesRef = useRef<(dataTransfer: DataTransfer, dest: string) => void>(() => {})

  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    initialState: { expandedItems: [ROOT_ID] },
    getItemName: (item) => dataRef.current[item.getId()]?.name ?? '',
    isItemFolder: (item) => dataRef.current[item.getId()]?.isFolder ?? false,
    dataLoader: {
      getItem: (id) => dataRef.current[id] ?? { name: '', isFolder: false, children: [] },
      getChildren: (id) => dataRef.current[id]?.children ?? [],
    },
    indent: 12,
    onPrimaryAction: (item) => {
      if (!item.isFolder()) onOpenPreview(item.getId())
    },
    // Folders rename too (they fan out to N notes via renameFolder).
    canRename: () => true,
    onRename: (item, value) => {
      const from = item.getId()
      const name = value.trim()
      if (!name) return
      if (item.isFolder()) {
        actions.renameFolder(from, name)
      } else {
        const to = joinPath(parentOf(from), withMdExtension(name))
        if (to !== from) void renameNote({ from, to })
      }
    },
    hotkeys: {
      customDelete: {
        hotkey: 'Delete',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused) actions.startDelete(targetsFrom(t), focused.isFolder())
        },
      },
      customBackspace: {
        hotkey: 'Backspace',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused) actions.startDelete(targetsFrom(t), focused.isFolder())
        },
      },
      // ⌘/Ctrl + X/C/V/D. Tokens are `KeyboardEvent.code`; `metaorcontrol`
      // matches Meta on macOS and Control elsewhere (headless-tree specialKeys).
      // Names must be `custom*` — the library reserves the un-prefixed keys.
      customCut: {
        hotkey: 'metaorcontrol+KeyX',
        preventDefault: true,
        handler: (_e, t) => actions.cut(targetsFrom(t)),
      },
      customCopy: {
        hotkey: 'metaorcontrol+KeyC',
        preventDefault: true,
        handler: (_e, t) => actions.copy(targetsFrom(t)),
      },
      customPaste: {
        hotkey: 'metaorcontrol+KeyV',
        preventDefault: true,
        handler: (_e, t) => actions.paste(destFolderFrom(t)),
      },
      customDuplicate: {
        hotkey: 'metaorcontrol+KeyD',
        preventDefault: true,
        handler: (_e, t) => actions.duplicate(targetsFrom(t)),
      },
    },
    // Drag files AND folders onto a folder = move; multi-drag moves the whole
    // selection as ONE atomic batch. No sibling reorder.
    canReorder: false,
    canDrag: () => true,
    canDrop: (items, target) => {
      const dest = target.item
      if (!dest.isFolder()) return false
      const destPath = dest.getId() === ROOT_ID ? '' : dest.getId()
      return items.every((i) => {
        const id = i.getId()
        if (parentOf(id) === destPath) return false // already there — a no-op
        if (destPath === id || destPath.startsWith(`${id}/`)) return false // into itself/descendant
        return true
      })
    },
    onDrop: (items, target) => {
      const destPath = target.item.getId() === ROOT_ID ? '' : target.item.getId()
      actions.moveInto(
        items.map((i) => i.getId()),
        destPath,
      )
    },
    // A drag carrying OS files, dropped on a ROW. Without these three the
    // library refuses the drop by returning from its `onDrop` *without*
    // `preventDefault()`, after `stopPropagation()`: the container handler never
    // sees it and Chromium treats the drop as a navigation, opening the file in
    // a new window. A row's file drag is a native `startDrag`, so the in-tree
    // move of a note arrives here as a file drop too.
    //
    // Scoped to `Files` so the tree's own web drag (no files) stays on the
    // `canDrop`/`onDrop` pair above.
    canDropForeignDragObject: (dataTransfer) => dataTransfer.types.includes('Files'),
    // Also `Files`-only: the default derived from the line above accepts any
    // foreign drag whose `effectAllowed` is not 'none', which would light a
    // folder up for a dragged text selection it cannot accept.
    canDragForeignDragObjectOver: (dataTransfer) => dataTransfer.types.includes('Files'),
    onDropForeignDragObject: (dataTransfer, target) => {
      const id = target.item.getId()
      // Focus the row that received the drop, as the library does for its own.
      // Not cosmetic: headless-tree ends a valid drop with `updateDomFocus()`,
      // which reads `getFocusedItem()` WITHOUT a null check and throws from a
      // `setTimeout` when nothing is focused (a fresh window).
      target.item.setFocused()
      // On a folder, that folder; on a file, the folder it is in; on the root
      // item, the vault root — the same rule the container drop follows.
      dropFilesRef.current(dataTransfer, id === ROOT_ID ? '' : dirSet.has(id) ? id : parentOf(id))
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
      // Provides tree.collapseAll() for the explorer header button.
      expandAllFeature,
    ],
  })

  // Re-read the whole tree when the snapshot changes (wholesale replace model).
  useEffect(() => {
    tree.rebuildTree()
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Answer a reveal request: expand down to the path, select it, focus the row
   * and bring it into view.
   *
   * **No dependency array on purpose.** Expanding a folder is headless-tree's
   * own state, not React's, so nothing here could be listed as a dep. The effect
   * runs on every render and claims the nonce only once the work is done; the
   * render the expansions cause lets the second pass find rows that now exist.
   */
  useEffect(() => {
    const req = revealRequest
    if (req === null || revealedNonce.current === req.nonce) return
    // A rename field owns the focus and the caret, so the request is dropped
    // rather than deferred: by the time the rename ends it is stale anyway.
    if (tree.isRenamingItem()) {
      revealedNonce.current = req.nonce
      return
    }
    const branch = ancestorsOf(req.path).filter((dir) => dataRef.current[dir])
    const collapsed = branch.filter((dir) => !tree.getItemInstance(dir).isExpanded())
    if (collapsed.length > 0) {
      for (const dir of collapsed) tree.getItemInstance(dir).expand()
      return // finish on the render those expansions cause
    }
    if (!dataRef.current[req.path]) return // not in the projection (yet, or ever)
    revealedNonce.current = req.nonce
    tree.setSelectedItems([req.path])
    const item = tree.getItemInstance(req.path)
    item.setFocused()
    void item.scrollTo({ block: 'nearest' })
  })

  const entry = vaults.find((v) => v.remote === activeRemote)
  const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)

  /**
   * Files from outside the renderer, landing in `dest`. Shared by the
   * container's drop on empty space and headless-tree's
   * `onDropForeignDragObject` for a drop on a row, so both paths agree.
   */
  const dropFiles = (dataTransfer: DataTransfer, dest: string): void => {
    setImporting(false)
    const sources = [...dataTransfer.files].map((f) => window.holi.pathForFile(f))
    if (sources.length === 0) return
    // A file dragged out of this very vault and dropped back into it is a
    // MOVE, so links are rewritten and open tabs follow; copying would leave a
    // duplicate with links still pointing at the original.
    const prefix = entry === undefined ? null : `${entry.path}/`
    const mine = prefix === null ? [] : sources.filter((p) => p.startsWith(prefix))
    const theirs = prefix === null ? sources : sources.filter((p) => !p.startsWith(prefix))
    const moving = mine.map((p) => p.slice(prefix!.length)).filter((rel) => parentOf(rel) !== dest)
    if (moving.length > 0) actions.moveInto(moving, dest)
    if (theirs.length > 0) void importDropped(theirs, dest).then(setSkipped)
  }
  dropFilesRef.current = dropFiles

  /** Everything the last import or export refused, in one list — see the banner. */
  const refused = [...skipped, ...actions.exportFailures]

  // The row's context-menu target set: the whole multi-selection when the clicked
  // row is part of it, else just that row (as a right-click in VS Code).
  const rowTargets = (id: string): string[] => {
    const sel = tree.getSelectedItems().map((it) => it.getId())
    return sel.length > 1 && sel.includes(id) ? sel : [id]
  }

  // A single row gets the create/rename/path actions; a multi-selection is
  // limited to the batch ops that make sense across a set.
  const rowMenu = (path: string, isFolder: boolean, targets: string[]) => {
    const folderDest = isFolder ? path : parentOf(path)
    const multi = targets.length > 1
    return (
      <ContextMenuContent
        // Keep focus on whatever an action opens (a rename field, a new-file row)
        // instead of Radix pulling it back to the row when the menu closes.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {!multi && !isFolder && (
          <>
            {/* A file's action, not a folder's. If the file is already open in
                another pane it goes there (`openInNewPane`): one buffer per file
                holds across panes. */}
            <ContextMenuItem onSelect={() => onOpenInNewPane(path)}>
              Open in a New Pane
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!multi && (
          <>
            <ContextMenuItem onSelect={() => setPending({ kind: 'file', parent: folderDest })}>
              New File…
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => setPending({ kind: 'folder', parent: folderDest })}>
              New Folder…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => tree.getItemInstance(path).startRenaming()}>
              Rename…
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            {/* Every row, not just notes: the icon map covers every path. */}
            <ContextMenuItem
              onSelect={() =>
                activeRemote !== null &&
                openDialog({
                  id: 'edit-icon',
                  size: 'sm',
                  // Its footer has Cancel; the corner ✕ would be a second one.
                  closable: false,
                  remote: activeRemote,
                  path,
                  current: snapshot.icons[path] ?? null,
                  onOpenMap: () => onOpenPinned(ICONS_FILE),
                })
              }
            >
              Edit Icon…
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem
          variant="destructive"
          onSelect={() => actions.startDelete(targets, isFolder)}
        >
          Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.cut(targets)}>
          Cut
          <ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copy(targets)}>
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.paste(folderDest)}>
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.duplicate(targets)}>
          Duplicate
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        {/* Out of the vault. Outside the `!multi` guard because both act on a
            whole selection and on folders, as Cut/Copy/Delete do. This is the
            only way out: dropping a row into Finder does not work
            (docs/not-built.md). */}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.copyOut(targets)}>Copy to Folder…</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.startMoveOut(targets, isFolder)}>
          Move to Folder…
        </ContextMenuItem>
        {!multi && (
          <>
            {fileKind(path) === 'markdown' && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() =>
                    activeRemote !== null &&
                    openDialog({ id: 'convert-to-pdf', size: 'md', remote: activeRemote, path })
                  }
                >
                  Convert to PDF…
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(absPathFor(path))}>
              Copy Path
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(path)}>
              Copy Relative Path
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void window.holi.openPath(absPathFor(path))}>
              Reveal in Finder
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    )
  }

  /**
   * Where the "new file" / "new folder" input opens: as a child of the target
   * folder, at the indent its contents will have.
   */
  const items = tree.getItems().filter((item) => item.getId() !== ROOT_ID)
  const rows = items.map((item) => ({ id: item.getId(), level: item.getItemMeta().level }))
  // Rows that have just appeared animate in. Computed from what CHANGED rather
  // than declared on the row, or every unrelated re-render would replay the
  // whole list (see lib/use-arrivals.ts).
  const { arrivalProps } = useArrivals(rows.map((r) => r.id))
  const slot = pending === null ? null : pendingSlot(rows, pending.parent)
  const pendingRow = (level: number) => (
    <PendingRow
      kind={pending!.kind}
      level={level}
      onCancel={() => setPending(null)}
      onCommit={(name) => {
        if (pending!.kind === 'folder') {
          const folder = joinPath(pending!.parent, name)
          // Show it at once (optimistic), and make it real on disk: a
          // `.gitkeep` so the empty folder persists and returns in `dirs`.
          actions.addPendingFolder(folder)
          void createFolder(folder)
        } else {
          // Open the created file once it lands: a non-md file is not in
          // `docs`, so opening a tab explicitly is what surfaces it.
          const path = joinPath(pending!.parent, withMdExtension(name))
          void createNote(path).then(() => onOpenPreview(path))
        }
        setPending(null)
      }}
    />
  )

  return (
    // Fills its panel; the resizable divider between it and the apps list sets
    // the boundary.
    <div className="group/explorer relative flex min-h-0 flex-1 flex-col">
      <ExplorerHeader
        onNewFile={() => setPending({ kind: 'file', parent: '' })}
        onNewFolder={() => setPending({ kind: 'folder', parent: '' })}
        onCollapseAll={() => tree.collapseAll()}
        hiddenShown={showHidden}
        onToggleHidden={toggleHidden}
        tasksShown={showTasks}
        onToggleTasks={toggleTasks}
        experiment={{ on: false, onToggle: () => onTryNavTree?.() }}
      />
      <div
        // pt-10 reserves the band the hover toolbar (ExplorerHeader, absolute
        // top-1) floats into, so it never covers the first row.
        className={cn(
          'min-h-0 flex-1 overflow-y-auto pb-1 pt-10 text-sm',
          importing && 'bg-primary/5 ring-1 ring-inset ring-primary/40',
        )}
        {...tree.getContainerProps()}
        // A drop from Finder. Guarded on the `Files` type so it never competes
        // with the tree's own drag, which carries no files.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setImporting(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setImporting(false)
        }}
        // Only a drop that missed every row reaches this: headless-tree stops
        // propagation on a row, and `onDropForeignDragObject` above is what
        // serves that case.
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          const row = (e.target as HTMLElement).closest?.('[data-path]')
          const id = row?.getAttribute('data-path') ?? null
          // Dropped on a folder, that folder; on a file, the folder it is in;
          // on empty space, the vault root.
          dropFiles(e.dataTransfer, id === null ? '' : dirSet.has(id) ? id : parentOf(id))
        }}
      >
        {/* One banner for both directions: a file that did not arrive and one
            that did not leave are the same class of outcome. */}
        {refused.length > 0 && (
          <Button
            variant="link"
            onClick={() => {
              setSkipped([])
              actions.dismissExportFailures()
            }}
            // amber = the warning role (no token yet); named utilities are gate-legal.
            className="mb-1 h-auto w-full justify-start whitespace-normal p-0 px-2 text-left text-[11px] text-amber-300/90 hover:text-amber-200"
          >
            {refused.map((s) => s.name).join(', ')} — {refused[0]!.reason}. Click to dismiss.
          </Button>
        )}
        {slot?.afterId === null && pendingRow(slot.level)}
        {items.map((item, i) => {
          const id = item.getId()
          const isFolder = item.isFolder()
          const isOpen = activePath === id
          const level = item.getItemMeta().level
          const isCut = actions.clipboard?.mode === 'cut' && actions.clipboard.paths.includes(id)
          const task = taskByPath.get(id)
          const arrival = arrivalProps(id)
          /**
           * A gap between the root's folders and its loose files, carried by
           * the first root file after the last folder (folders sort first).
           * Inside a folder the indent already separates them.
           */
          const prev = i > 0 ? items[i - 1] : undefined
          const startsRootFiles =
            level === 0 &&
            !isFolder &&
            prev !== undefined &&
            prev.getItemMeta().level === 0 &&
            prev.isFolder()
          /**
           * Gitignored, dimmed. On the row's CONTENTS rather than the row, so a
           * dimmed file still gets a solid selection highlight. `isCut` dims the
           * whole row because it is a transient pending move.
           */
          const dim = ignoredSet.has(id) ? 'opacity-50' : ''
          const rowProps = item.getProps()
          const origClick = rowProps.onClick as ((e: unknown) => void) | undefined
          const row = (
            <ContextMenu key={id}>
              <ContextMenuTrigger asChild>
                <div
                  {...rowProps}
                  data-path={id}
                  // A web drag cannot tell the OS a file is involved, so a file
                  // row hands the gesture to `startDrag`. Dropped back on this
                  // window it arrives as a file drop, which is where the
                  // in-tree move happens (Finder refuses the drop, see
                  // docs/not-built.md). A folder keeps the web drag.
                  onDragStart={(e) => {
                    if (isFolder) return
                    e.preventDefault()
                    window.holi.startDrag(rowTargets(id).map(absPathFor))
                  }}
                  onClick={(e) => {
                    // ⇧ toggles one row in or out of the selection, and ⌘ on a
                    // file opens it in a new pane. Both are handled here because
                    // headless-tree's click handler reads ⇧ as a range and ⌘ as
                    // the toggle.
                    if (e.shiftKey) {
                      item.setFocused()
                      item.toggleSelect()
                    } else if (e.metaKey && !isFolder) {
                      item.setFocused()
                      tree.setSelectedItems([id])
                      onOpenInNewPane(id)
                    } else {
                      origClick?.(e)
                    }
                  }}
                  onDoubleClick={() => {
                    if (!isFolder) onOpenPinned(id)
                  }}
                  style={{ paddingLeft: `${level * 12 + 8}px`, ...arrival.style }}
                  className={[
                    'motion-respond flex h-[22px] items-center gap-1 rounded pr-2 outline-none',
                    startsRootFiles ? 'mt-2' : '',
                    arrival.className ?? '',
                    item.isSelected()
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60',
                    isOpen ? 'text-brand' : '',
                    item.isDragTarget() ? 'bg-primary/20 ring-1 ring-inset ring-primary/60' : '',
                    isCut ? 'opacity-40' : '',
                  ].join(' ')}
                >
                  {/* The chevron column exists only on folders, so a root file
                        lines up with its sibling folders. Nesting is said by
                        the row's indent. */}
                  {isFolder && (
                    <span
                      className={`flex w-4 shrink-0 justify-center text-muted-foreground ${dim}`}
                    >
                      <ChevronIcon open={item.isExpanded()} />
                    </span>
                  )}
                  <span
                    data-slot="row-icon"
                    className={`flex w-4 shrink-0 justify-center ${isOpen ? 'text-brand' : 'text-muted-foreground'} ${dim}`}
                  >
                    {iconByPath.has(id) ? (
                      fileIconFor(id, iconByPath.get(id))
                    ) : isFolder ? (
                      isAppRootPath(id) ? (
                        <AppFolderIcon />
                      ) : (
                        <FolderIcon />
                      )
                    ) : task ? (
                      <TaskIcon status={task.status} />
                    ) : (
                      fileIconFor(id)
                    )}
                  </span>
                  {item.isRenaming() ? (
                    <Input
                      {...item.getRenameInputProps()}
                      autoFocus
                      className="h-[22px] flex-1 rounded border-primary bg-background px-1 py-0 text-sm shadow-none"
                      onFocus={(e) => {
                        const el = e.currentTarget
                        const [s, end] = renameBasenameRange(el.value)
                        setTimeout(() => el.setSelectionRange(s, end), 0)
                      }}
                    />
                  ) : (
                    <>
                      <span
                        className={`min-w-0 flex-1 truncate ${dim} ${
                          task?.status === 'done' ? 'text-muted-foreground line-through' : ''
                        }`}
                      >
                        {item.getItemName()}
                      </span>
                      {/* Today's daily, marked where it lives
                            (docs/features/daily-notes.md). Absent in a shared
                            vault, which has no daily. */}
                      {id === todayDailyPath && (
                        <span className="shrink-0 rounded-full bg-brand/15 px-1.5 text-[10px] leading-4 text-brand">
                          today
                          {todayLinkCount > 0 && ` · ${todayLinkCount}`}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              {rowMenu(id, isFolder, rowTargets(id))}
            </ContextMenu>
          )
          // The input opens where the file will land.
          return slot?.afterId === id ? (
            <Fragment key={id}>
              {row}
              {pendingRow(slot.level)}
            </Fragment>
          ) : (
            row
          )
        })}
        {tree.getItems().filter((item) => item.getId() !== ROOT_ID).length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">no notes yet</p>
        )}
      </div>

      {actions.confirming && (
        <DeleteConfirm
          verb={actions.confirmVerb}
          label={actions.confirming.label}
          refs={actions.confirming.refs}
          onCancel={actions.cancelDelete}
          onConfirm={actions.confirmDelete}
        />
      )}
    </div>
  )
}
