/**
 * The vault as a VS Code-style explorer.
 *
 * Pure projection of `snapshotAtom` (plus a client-only `pendingFolders` set for
 * transient folders, added in a later task). headless-tree owns
 * selection/focus/expansion/keyboard; every mutation runs through our atoms so
 * the link-rewrite rename and backref/tombstone delete stay ours.
 *
 * The data loader reads from a ref kept current every render, and a `rebuildTree`
 * effect re-reads when the snapshot changes — the snapshot is replaced wholesale,
 * so the tree must be told to invalidate rather than diffing frames.
 */
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DeleteConfirm } from './tree/DeleteConfirm'
import { ExplorerHeader } from './tree/ExplorerHeader'
import { TreeContextMenu, type MenuItem } from './tree/TreeContextMenu'
import { ChevronIcon, FolderIcon, MarkdownIcon } from './tree/icons'
import { buildTreeData, ROOT_ID, type TreeItemData } from '../lib/tree-data'
import { joinPath, parentOf, renameBasenameRange, withMdExtension } from '../lib/tree-paths'
import {
  activeRemoteAtom,
  backrefsFor,
  createNoteAtom,
  deleteNoteAtom,
  renameNoteAtom,
  snapshotAtom,
  vaultsAtom,
} from '../state/vaults'

/** The inline editable row shown when creating a file or folder. Escape cancels,
 *  Enter commits, blur cancels — matching the tree's rename input. */
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
  const renameNote = useSetAtom(renameNoteAtom)
  const createNote = useSetAtom(createNoteAtom)
  const deleteNote = useSetAtom(deleteNoteAtom)
  const getBackrefs = useSetAtom(backrefsFor)
  // Right-click menu at a cursor position, and the delete-preview dialog.
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isFolder: boolean } | null>(
    null,
  )
  const [confirming, setConfirming] = useState<{ path: string; refs: { path: string; count: number }[] } | null>(
    null,
  )
  // Transient folders (spec §Empty folders): client-only until a note lands.
  const [pendingFolders, setPendingFolders] = useState<string[]>([])
  // An inline-create row: kind + the folder it is created under (rendered in a
  // later task; the header buttons seed it here).
  const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)

  const data = useMemo(
    () => buildTreeData(snapshot.docs.map((d) => d.path), pendingFolders),
    [snapshot, pendingFolders],
  )
  // The data loader closures read from here so they always see the latest data,
  // regardless of when headless-tree captured the config.
  const dataRef = useRef<Record<string, TreeItemData>>(data)
  dataRef.current = data

  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    // The synthetic root must be expanded or its children never enter getItems().
    initialState: { expandedItems: [ROOT_ID] },
    getItemName: (item) => dataRef.current[item.getId()]?.name ?? '',
    isItemFolder: (item) => dataRef.current[item.getId()]?.isFolder ?? false,
    dataLoader: {
      getItem: (id) => dataRef.current[id] ?? { name: '', isFolder: false, children: [] },
      getChildren: (id) => dataRef.current[id]?.children ?? [],
    },
    indent: 12,
    // Keyboard Enter / other primary triggers open a preview tab.
    onPrimaryAction: (item) => {
      if (!item.isFolder()) onOpenPreview(item.getId())
    },
    canRename: (item) => !item.isFolder(),
    onRename: (item, value) => {
      const from = item.getId()
      const slash = from.lastIndexOf('/')
      const parent = slash === -1 ? '' : from.slice(0, slash)
      const to = joinPath(parent, withMdExtension(value.trim()))
      if (value.trim() && to !== from) void renameNote({ from, to })
    },
    // Delete / Backspace on the focused file opens the backref preview (files
    // only in Phase 1). arrow-nav / typeahead / F2 come free with the features.
    hotkeys: {
      customDelete: {
        hotkey: 'Delete',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused && !focused.isFolder()) {
            const path = focused.getId()
            void getBackrefs(path).then((refs) => setConfirming({ path, refs }))
          }
        },
      },
      customBackspace: {
        hotkey: 'Backspace',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused && !focused.isFolder()) {
            const path = focused.getId()
            void getBackrefs(path).then((refs) => setConfirming({ path, refs }))
          }
        },
      },
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
    ],
  })

  // Re-read the whole tree when the snapshot changes (wholesale replace model).
  useEffect(() => {
    tree.rebuildTree()
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  // A transient folder becomes real once the snapshot carries a note inside it;
  // drop it from the pending set so it is not double-represented.
  useEffect(() => {
    const paths = snapshot.docs.map((d) => d.path)
    setPendingFolders((f) => f.filter((folder) => !paths.some((p) => p.startsWith(`${folder}/`))))
  }, [snapshot])

  const entry = vaults.find((v) => v.remote === activeRemote)
  // Copy Path / Reveal in Finder need the absolute clone path; the tree only
  // knows vault-relative paths.
  const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)
  // Look before you leap: name what links here so the delete is informed (FR-12).
  const startDelete = (path: string) =>
    void getBackrefs(path).then((refs) => setConfirming({ path, refs }))

  const buildMenu = (path: string, isFolder: boolean): (MenuItem | 'separator')[] => {
    const folderParent = isFolder ? path : parentOf(path)
    return [
      { label: 'New File…', onSelect: () => setPending({ kind: 'file', parent: folderParent }) },
      { label: 'New Folder…', onSelect: () => setPending({ kind: 'folder', parent: folderParent }) },
      'separator',
      // Folder rename/delete are Phase 2 (they fan out to N notes); Phase 1 acts
      // on files only.
      ...(isFolder
        ? []
        : ([
            {
              label: 'Rename…',
              kbd: 'F2',
              onSelect: () => tree.getItemInstance(path).startRenaming(),
            },
            { label: 'Delete', kbd: '⌫', danger: true, onSelect: () => startDelete(path) },
          ] as MenuItem[])),
      ...(isFolder ? [] : (['separator'] as const)),
      { label: 'Copy Path', onSelect: () => void navigator.clipboard.writeText(absPathFor(path)) },
      { label: 'Copy Relative Path', onSelect: () => void navigator.clipboard.writeText(path) },
      { label: 'Reveal in Finder', onSelect: () => void window.holi.openPath(absPathFor(path)) },
    ]
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExplorerHeader
        title={activeRemote?.split('/').at(-1) ?? 'vault'}
        onNewFile={() => setPending({ kind: 'file', parent: '' })}
        onNewFolder={() => setPending({ kind: 'folder', parent: '' })}
        onCollapseAll={() => tree.collapseAll()}
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
                void createNote(joinPath(pending.parent, withMdExtension(name)))
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
          const rowProps = item.getProps()
          const origClick = rowProps.onClick as ((e: unknown) => void) | undefined
          return (
            <div
              key={id}
              {...rowProps}
              onClick={(e) => {
                origClick?.(e)
                if (!isFolder) onOpenPreview(id)
              }}
              onDoubleClick={() => {
                if (!isFolder) onOpenPinned(id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, path: id, isFolder })
              }}
              style={{ paddingLeft: `${level * 12 + 8}px` }}
              className={[
                'flex h-[22px] items-center gap-1 rounded pr-2 outline-none transition-colors',
                item.isSelected()
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800/60',
                isOpen ? 'text-sky-300' : '',
              ].join(' ')}
            >
              <span className="flex w-4 shrink-0 justify-center text-neutral-500">
                {isFolder ? <ChevronIcon open={item.isExpanded()} /> : null}
              </span>
              <span
                className={`flex w-4 shrink-0 justify-center ${isOpen ? 'text-sky-400' : 'text-neutral-500'}`}
              >
                {isFolder ? <FolderIcon /> : <MarkdownIcon />}
              </span>
              {item.isRenaming() ? (
                <input
                  {...item.getRenameInputProps()}
                  autoFocus
                  className="min-w-0 flex-1 rounded border border-sky-700 bg-neutral-900 px-1 text-sm outline-none"
                  onFocus={(e) => {
                    // Defer past headless-tree's own focus handling (which puts the
                    // caret at the end) so the basename — not the extension — ends
                    // up selected, as in VS Code.
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
          items={buildMenu(menu.path, menu.isFolder)}
          onClose={() => setMenu(null)}
        />
      )}
      {confirming && (
        <DeleteConfirm
          path={confirming.path}
          refs={confirming.refs}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const path = confirming.path
            setConfirming(null)
            void deleteNote(path)
          }}
        />
      )}
    </div>
  )
}
