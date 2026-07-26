/**
 * The vault as a VS Code-style explorer — Phase 2: multi-select, folder
 * rename/delete/move, drag-and-drop (files and folders, atomic multi-move), and
 * cut/copy/paste/duplicate.
 *
 * Pure projection of `snapshotAtom` (plus a client-only `pendingFolders` set for
 * transient folders). headless-tree owns selection/focus/expansion/keyboard;
 * every mutation runs through the batch atoms so the single-pass link-rewrite
 * move and the backref/tombstone delete stay ours. Handlers read the freshest
 * snapshot/clipboard through refs, because headless-tree captures its config
 * closures once.
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
import { fileKind, isHiddenPath } from '@holi/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConvertToPdfDialog } from './ConvertToPdfDialog'
import { DeleteConfirm } from './tree/DeleteConfirm'
import { ExplorerHeader } from './tree/ExplorerHeader'
import { TreeContextMenu, type MenuItem } from './tree/TreeContextMenu'
import { ChevronIcon, FolderIcon, MarkdownIcon } from './tree/icons'
import { fileIconFor } from './tree/file-icons'
import { buildTreeData, ROOT_ID, type TreeItemData } from '../lib/tree-data'
import {
  basename,
  expandToFiles,
  freeCopyPath,
  joinPath,
  parentOf,
  pathTaken,
  remapUnder,
  renameBasenameRange,
  withMdExtension,
} from '../lib/tree-paths'
import {
  activeRemoteAtom,
  backrefsForMany,
  copyNotesAtom,
  createNoteAtom,
  deleteManyAtom,
  moveNotesAtom,
  renameNoteAtom,
  showHiddenByVaultAtom,
  snapshotAtom,
  vaultsAtom,
} from '../state/vaults'

/** The inline editable row shown when creating a file or folder. */
function PendingRow({
  kind,
  onCommit,
  onCancel,
}: {
  kind: 'file' | 'folder'
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  return (
    <div className="flex h-[22px] items-center gap-1 pr-2" style={{ paddingLeft: '8px' }}>
      <span className="flex w-4 shrink-0 justify-center text-neutral-500">
        {kind === 'folder' ? <FolderIcon /> : <MarkdownIcon />}
      </span>
      <input
        autoFocus
        className="min-w-0 flex-1 rounded border border-sky-700 bg-neutral-900 px-1 text-sm outline-none"
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

type Clipboard = { mode: 'cut' | 'copy'; paths: string[] } | null

export function FileTree({
  activePath,
  onOpenPreview,
  onOpenPinned,
}: {
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
}) {
  const snapshot = useAtomValue(snapshotAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const [showHiddenByVault, setShowHiddenByVault] = useAtom(showHiddenByVaultAtom)
  // Per-vault "show hidden files" flag; a vault never toggled defaults to hidden.
  const showHidden = activeRemote !== null && showHiddenByVault[activeRemote] === true
  const toggleHidden = () => {
    if (activeRemote === null) return
    setShowHiddenByVault({ ...showHiddenByVault, [activeRemote]: !showHidden })
  }
  const renameNote = useSetAtom(renameNoteAtom)
  const createNote = useSetAtom(createNoteAtom)
  const moveNotes = useSetAtom(moveNotesAtom)
  const copyNotes = useSetAtom(copyNotesAtom)
  const deleteMany = useSetAtom(deleteManyAtom)
  const getBackrefs = useSetAtom(backrefsForMany)

  const [menu, setMenu] = useState<{
    x: number
    y: number
    path: string
    isFolder: boolean
    targets: string[]
  } | null>(null)
  const [confirming, setConfirming] = useState<{
    label: string
    paths: string[]
    refs: { path: string; count: number }[]
  } | null>(null)
  // The vault-relative path of the note whose Convert-to-PDF dialog is open.
  const [converting, setConverting] = useState<string | null>(null)
  const [pendingFolders, setPendingFolders] = useState<string[]>([])
  const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)
  // Cut/Copy staging (spec §Cut/Copy). Cut dims its rows; paste consumes a cut,
  // keeps a copy (VS Code pastes a copy repeatedly).
  const [clipboard, setClipboard] = useState<Clipboard>(null)

  // The tree projects notes AND non-markdown files (spec §Arbitrary files); the
  // scanner keeps them in separate lists so link-aware ops stay markdown-only.
  const docPaths = useMemo(
    () => [...snapshot.docs.map((d) => d.path), ...snapshot.files.map((f) => f.path)],
    [snapshot],
  )
  // Hidden (dot-prefixed) entries are filtered out unless the per-vault toggle is
  // on. Managed non-dot files (AGENTS.md, CLAUDE.md, MEMORY.md) are never hidden.
  const data = useMemo(() => {
    const visible = showHidden ? docPaths : docPaths.filter((p) => !isHiddenPath(p))
    return buildTreeData(visible, pendingFolders)
  }, [docPaths, pendingFolders, showHidden])

  // headless-tree captures config closures once; these refs keep the handlers
  // reading the latest values.
  const dataRef = useRef(data)
  dataRef.current = data
  const docPathsRef = useRef(docPaths)
  docPathsRef.current = docPaths
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard

  // ── batch action helpers (no `tree` closure — targets come from the caller) ──

  const filesUnder = (targets: string[]): string[] => {
    const out = new Set<string>()
    for (const t of targets) for (const f of expandToFiles(docPathsRef.current, t)) out.add(f)
    return [...out]
  }

  const startDelete = (targets: string[], isFolder: boolean) => {
    const files = filesUnder(targets)
    if (files.length === 0) {
      // Nothing on disk — a transient (empty) folder; just drop it from pending.
      setPendingFolders((f) => f.filter((x) => !targets.includes(x)))
      return
    }
    const label =
      targets.length > 1
        ? `${files.length} notes`
        : isFolder
          ? `${targets[0]}/ (${files.length} note${files.length === 1 ? '' : 's'})`
          : targets[0]!
    void getBackrefs(files).then((refs) => setConfirming({ label, paths: files, refs }))
  }

  const moveInto = (sources: string[], destFolder: string) => {
    const moves = sources
      .flatMap((s) => remapUnder(docPathsRef.current, s, joinPath(destFolder, basename(s))))
      .filter((m) => m.from !== m.to)
    if (moves.length) void moveNotes({ moves })
  }

  const renameFolder = (folder: string, newName: string) => {
    const dest = joinPath(parentOf(folder), newName)
    if (dest === folder) return
    const files = expandToFiles(docPathsRef.current, folder)
    if (files.length === 0) {
      setPendingFolders((f) => f.map((x) => (x === folder ? dest : x)))
      return
    }
    const moves = remapUnder(docPathsRef.current, folder, dest).filter((m) => m.from !== m.to)
    if (moves.length) void moveNotes({ moves })
  }

  const paste = (destFolder: string) => {
    const clip = clipboardRef.current
    if (!clip) return
    if (clip.mode === 'cut') {
      moveInto(clip.paths, destFolder)
      setClipboard(null)
      return
    }
    const claimed = new Set(docPathsRef.current)
    const isTaken = (p: string) => pathTaken(claimed, p)
    const copies: { from: string; to: string }[] = []
    for (const src of clip.paths) {
      const destRoot = freeCopyPath(isTaken, joinPath(destFolder, basename(src)))
      for (const from of expandToFiles(docPathsRef.current, src)) {
        const to = destRoot + from.slice(src.length)
        claimed.add(to)
        copies.push({ from, to })
      }
    }
    if (copies.length) void copyNotes({ copies })
  }

  const duplicate = (targets: string[]) => {
    const claimed = new Set(docPathsRef.current)
    const isTaken = (p: string) => pathTaken(claimed, p)
    const copies: { from: string; to: string }[] = []
    for (const src of targets) {
      const newRoot = freeCopyPath(isTaken, src)
      for (const from of expandToFiles(docPathsRef.current, src)) {
        const to = newRoot + from.slice(src.length)
        claimed.add(to)
        copies.push({ from, to })
      }
    }
    if (copies.length) void copyNotes({ copies })
  }

  // Selection-aware target set from a tree instance: the whole multi-selection
  // when the focused/clicked row is part of it, else just that one row (VS Code).
  const targetsFrom = (t: TreeInstance<TreeItemData>, clickedId?: string): string[] => {
    const sel = t.getSelectedItems().map((i) => i.getId())
    if (clickedId !== undefined) return sel.length > 1 && sel.includes(clickedId) ? sel : [clickedId]
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
    // Folders rename too now (they fan out to N notes via renameFolder).
    canRename: () => true,
    onRename: (item, value) => {
      const from = item.getId()
      const name = value.trim()
      if (!name) return
      if (item.isFolder()) {
        renameFolder(from, name)
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
          if (focused) startDelete(targetsFrom(t), focused.isFolder())
        },
      },
      customBackspace: {
        hotkey: 'Backspace',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused) startDelete(targetsFrom(t), focused.isFolder())
        },
      },
      // ⌘/Ctrl + X/C/V/D. Tokens are `KeyboardEvent.code`; `metaorcontrol`
      // matches Meta on macOS and Control elsewhere (headless-tree specialKeys).
      // Names must be `custom*` — the library reserves the un-prefixed keys.
      customCut: {
        hotkey: 'metaorcontrol+KeyX',
        preventDefault: true,
        handler: (_e, t) => setClipboard({ mode: 'cut', paths: targetsFrom(t) }),
      },
      customCopy: {
        hotkey: 'metaorcontrol+KeyC',
        preventDefault: true,
        handler: (_e, t) => setClipboard({ mode: 'copy', paths: targetsFrom(t) }),
      },
      customPaste: {
        hotkey: 'metaorcontrol+KeyV',
        preventDefault: true,
        handler: (_e, t) => paste(destFolderFrom(t)),
      },
      customDuplicate: {
        hotkey: 'metaorcontrol+KeyD',
        preventDefault: true,
        handler: (_e, t) => duplicate(targetsFrom(t)),
      },
    },
    // Drag files AND folders onto a folder = move; multi-drag moves the whole
    // selection as ONE atomic batch (spec §Drag-and-drop). No sibling reorder.
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
      moveInto(
        items.map((i) => i.getId()),
        destPath,
      )
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

  // A transient folder becomes real once the snapshot carries a note inside it.
  useEffect(() => {
    setPendingFolders((f) => f.filter((folder) => !docPaths.some((p) => p.startsWith(`${folder}/`))))
  }, [docPaths])

  const entry = vaults.find((v) => v.remote === activeRemote)
  const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)

  const buildMenu = (path: string, isFolder: boolean, targets: string[]): (MenuItem | 'separator')[] => {
    const folderDest = isFolder ? path : parentOf(path)
    const multi = targets.length > 1
    const items: (MenuItem | 'separator')[] = []
    if (!multi) {
      items.push(
        { label: 'New File…', onSelect: () => setPending({ kind: 'file', parent: folderDest }) },
        { label: 'New Folder…', onSelect: () => setPending({ kind: 'folder', parent: folderDest }) },
        'separator',
        { label: 'Rename…', kbd: 'F2', onSelect: () => tree.getItemInstance(path).startRenaming() },
      )
    }
    items.push(
      { label: 'Delete', kbd: '⌫', danger: true, onSelect: () => startDelete(targets, isFolder) },
      'separator',
      { label: 'Cut', kbd: '⌘X', onSelect: () => setClipboard({ mode: 'cut', paths: targets }) },
      { label: 'Copy', kbd: '⌘C', onSelect: () => setClipboard({ mode: 'copy', paths: targets }) },
      { label: 'Paste', kbd: '⌘V', onSelect: () => paste(folderDest) },
      { label: 'Duplicate', kbd: '⌘D', onSelect: () => duplicate(targets) },
    )
    if (!multi) {
      if (fileKind(path) === 'markdown') {
        items.push('separator', {
          label: 'Convert to PDF…',
          onSelect: () => setConverting(path),
        })
      }
      items.push(
        'separator',
        { label: 'Copy Path', onSelect: () => void navigator.clipboard.writeText(absPathFor(path)) },
        { label: 'Copy Relative Path', onSelect: () => void navigator.clipboard.writeText(path) },
        { label: 'Reveal in Finder', onSelect: () => void window.holi.openPath(absPathFor(path)) },
      )
    }
    return items
  }

  return (
    <div className="group/explorer relative flex min-h-0 flex-1 flex-col">
      <ExplorerHeader
        onNewFile={() => setPending({ kind: 'file', parent: '' })}
        onNewFolder={() => setPending({ kind: 'folder', parent: '' })}
        onCollapseAll={() => tree.collapseAll()}
        hiddenShown={showHidden}
        onToggleHidden={toggleHidden}
      />
      <div
        className="holi-scroll min-h-0 flex-1 overflow-y-auto py-1 text-sm"
        {...tree.getContainerProps()}
      >
        {pending && (
          <PendingRow
            kind={pending.kind}
            onCancel={() => setPending(null)}
            onCommit={(name) => {
              if (pending.kind === 'folder') {
                setPendingFolders((f) => [...f, joinPath(pending.parent, name)])
              } else {
                // Open the created file once it lands — a non-md file is not in
                // `docs`, so opening a tab explicitly is what surfaces it.
                const path = joinPath(pending.parent, withMdExtension(name))
                void createNote(path).then(() => onOpenPreview(path))
              }
              setPending(null)
            }}
          />
        )}
        {tree
          .getItems()
          .filter((item) => item.getId() !== ROOT_ID)
          .map((item) => {
            const id = item.getId()
            const isFolder = item.isFolder()
            const isOpen = activePath === id
            const level = item.getItemMeta().level
            const isCut = clipboard?.mode === 'cut' && clipboard.paths.includes(id)
            const rowProps = item.getProps()
            const origClick = rowProps.onClick as ((e: unknown) => void) | undefined
            return (
              <div
                key={id}
                {...rowProps}
                onClick={(e) => {
                  origClick?.(e)
                  // A plain click opens a preview; a modified click is a
                  // selection gesture (⌘/⇧) and must not open anything.
                  if (!isFolder && !e.metaKey && !e.shiftKey && !e.ctrlKey) onOpenPreview(id)
                }}
                onDoubleClick={() => {
                  if (!isFolder) onOpenPinned(id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const sel = tree.getSelectedItems().map((it) => it.getId())
                  const targets = sel.length > 1 && sel.includes(id) ? sel : [id]
                  setMenu({ x: e.clientX, y: e.clientY, path: id, isFolder, targets })
                }}
                style={{ paddingLeft: `${level * 12 + 8}px` }}
                className={[
                  'flex h-[22px] items-center gap-1 rounded pr-2 outline-none transition-colors',
                  item.isSelected()
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-800/60',
                  isOpen ? 'text-sky-300' : '',
                  item.isDragTarget() ? 'bg-sky-500/20 ring-1 ring-inset ring-sky-500/60' : '',
                  isCut ? 'opacity-40' : '',
                ].join(' ')}
              >
                <span className="flex w-4 shrink-0 justify-center text-neutral-500">
                  {isFolder ? <ChevronIcon open={item.isExpanded()} /> : null}
                </span>
                <span
                  className={`flex w-4 shrink-0 justify-center ${isOpen ? 'text-sky-400' : 'text-neutral-500'}`}
                >
                  {isFolder ? <FolderIcon /> : fileIconFor(id)}
                </span>
                {item.isRenaming() ? (
                  <input
                    {...item.getRenameInputProps()}
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-sky-700 bg-neutral-900 px-1 text-sm outline-none"
                    onFocus={(e) => {
                      const el = e.currentTarget
                      const [s, end] = renameBasenameRange(el.value)
                      setTimeout(() => el.setSelectionRange(s, end), 0)
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{item.getItemName()}</span>
                )}
              </div>
            )
          })}
        {tree.getItems().filter((item) => item.getId() !== ROOT_ID).length === 0 && (
          <p className="px-2 text-xs text-neutral-500">no notes yet</p>
        )}
      </div>

      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenu(menu.path, menu.isFolder, menu.targets)}
          onClose={() => setMenu(null)}
        />
      )}
      {confirming && (
        <DeleteConfirm
          label={confirming.label}
          refs={confirming.refs}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const paths = confirming.paths
            setConfirming(null)
            void deleteMany({ paths })
          }}
        />
      )}
      {converting !== null && activeRemote !== null && (
        <ConvertToPdfDialog
          remote={activeRemote}
          path={converting}
          onClose={() => setConverting(null)}
        />
      )}
    </div>
  )
}
