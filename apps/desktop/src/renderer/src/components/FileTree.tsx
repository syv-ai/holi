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
import { ChevronIcon, FolderIcon, MarkdownIcon } from './tree/icons'
import { buildTreeData, ROOT_ID, type TreeItemData } from '../lib/tree-data'
import { joinPath, renameBasenameRange, withMdExtension } from '../lib/tree-paths'
import { renameNoteAtom, snapshotAtom } from '../state/vaults'

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
  const renameNote = useSetAtom(renameNoteAtom)
  // Transient folders (spec §Empty folders): client-only until a note lands.
  const [pendingFolders] = useState<string[]>([])

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="holi-scroll min-h-0 flex-1 overflow-y-auto py-1 text-sm"
        {...tree.getContainerProps()}
      >
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
                    const [s, end] = renameBasenameRange(e.currentTarget.value)
                    e.currentTarget.setSelectionRange(s, end)
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
    </div>
  )
}
