import { fileKind, ICONS_FILE } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/primitives'
import { parentOf } from '@/lib/tree-paths'
import { openDialogAtom } from '@/state/dialogs'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import type { ExplorerActions } from './useExplorerActions'

/**
 * A file tree row's context menu. A single row gets the create, rename and
 * path actions; a multi-selection is limited to the batch ops that make sense
 * across a set.
 */
export function RowMenu({
  path,
  isFolder,
  targets,
  actions,
  onOpenInNewPane,
  onOpenPinned,
  onNew,
  onRename,
}: {
  path: string
  isFolder: boolean
  /** The whole selection when the row is part of it, else just the row. */
  targets: string[]
  actions: ExplorerActions
  onOpenInNewPane: (path: string) => void
  onOpenPinned: (path: string) => void
  /** Open the tree's name input for a new file or folder inside `parent`. */
  onNew: (kind: 'file' | 'folder', parent: string) => void
  onRename: () => void
}) {
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const icons = useAtomValue(snapshotAtom).icons
  const openDialog = useSetAtom(openDialogAtom)
  const entry = vaults.find((v) => v.remote === activeRemote)
  const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)
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
          <ContextMenuItem onSelect={() => onNew('file', folderDest)}>New File…</ContextMenuItem>
          <ContextMenuItem onSelect={() => onNew('folder', folderDest)}>
            New Folder…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onRename}>
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
                current: icons[path] ?? null,
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
