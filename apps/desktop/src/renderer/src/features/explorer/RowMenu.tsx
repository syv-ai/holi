import { fileKind, ICONS_FILE } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check } from 'lucide-react'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  Icon,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { FOLDER_COLOURS, FOLDER_COLOUR_LABEL, FOLDER_SWATCH } from '@/lib/folder-colour'
import { parentOf } from '@/lib/tree-paths'
import { openDialogAtom } from '@/state/dialogs'
import { folderColoursAtom, setFolderColourAtom } from '@/state/folder-colours'
import { pinsAtom, togglePinAtom } from '@/state/pins'
import { claimsAtom } from '@/state/plugins'
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
  document,
  onToggleContents,
  targets,
  actions,
  onOpenInNewPane,
  onOpenPinned,
  onNew,
  onRename,
}: {
  path: string
  isFolder: boolean
  /** Set when the row is a folder document (an app): whether its files are
   *  showing, whether there is anything to open yet, and what it is called as
   *  a kind ("App"). */
  document: { open: boolean; ready: boolean; noun: string } | null
  /** Show or hide a document's files in the tree. */
  onToggleContents: () => void
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
  const snapshot = useAtomValue(snapshotAtom)
  const icons = snapshot.icons
  const openDialog = useSetAtom(openDialogAtom)
  const pinned = useAtomValue(pinsAtom)
  const togglePin = useSetAtom(togglePinAtom)
  const colour = useAtomValue(folderColoursAtom)[path]
  const setColour = useSetAtom(setFolderColourAtom)
  // What enabled claims add for this path, in claim order: those whose
  // condition holds.
  const claimItems = useAtomValue(claimsAtom).flatMap((c) =>
    c.match(path) ? (c.rowMenu ?? []).filter((item) => item.when?.(path, snapshot) ?? true) : [],
  )
  const entry = vaults.find((v) => v.remote === activeRemote)
  const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)
  // Something made or pasted on a document lands beside it, as on a file.
  const folderDest = isFolder && document === null ? path : parentOf(path)
  const multi = targets.length > 1
  return (
    <ContextMenuContent
      // Keep focus on whatever an action opens (a rename field, a new-file row)
      // instead of Radix pulling it back to the row when the menu closes.
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      {!multi && document !== null && (
        <>
          {/* A draft has nothing to open yet; its claim may offer a way to
              finish it, below. */}
          {document.ready && (
            <>
              <ContextMenuItem onSelect={() => onOpenPinned(path)}>Open</ContextMenuItem>
              <ContextMenuItem onSelect={() => onOpenInNewPane(path)}>
                Open in a New Pane
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem onSelect={onToggleContents}>
            {`${document.open ? 'Hide' : 'Show'} ${document.noun} Files`}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
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
          {/* Into the sidebar's Pinned section, on this machine. */}
          <ContextMenuItem onSelect={() => togglePin(path)}>
            {pinned.includes(path) ? 'Unpin from Sidebar' : 'Pin to Sidebar'}
          </ContextMenuItem>
          {/* A plain folder's colour, on this machine (`state/folder-colours.ts`). */}
          {isFolder && document === null && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Colour</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-40">
                {FOLDER_COLOURS.map((c) => (
                  <ContextMenuItem key={c} onSelect={() => setColour({ path, colour: c })}>
                    <span
                      aria-hidden="true"
                      className={cn('size-3 shrink-0 rounded-full', FOLDER_SWATCH[c])}
                    />
                    <span className="flex-1">{FOLDER_COLOUR_LABEL[c]}</span>
                    {colour === c && <Icon icon={Check} size="sm" />}
                  </ContextMenuItem>
                ))}
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={colour === undefined}
                  onSelect={() => setColour({ path, colour: null })}
                >
                  No colour
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
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
          {claimItems.length > 0 && activeRemote !== null && (
            <>
              <ContextMenuSeparator />
              {claimItems.map((item) => (
                <ContextMenuItem
                  key={item.label}
                  onSelect={() => item.run({ remote: activeRemote, path, openDialog })}
                >
                  {item.label}
                </ContextMenuItem>
              ))}
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
