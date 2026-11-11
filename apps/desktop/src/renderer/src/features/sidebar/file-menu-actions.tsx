import type { ItemInstance } from '@headless-tree/core'
import type { VaultSnapshot } from '@holi/shared'
import { isHoliLinkable } from '@holi/shared'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FilePlusIcon,
  FileSymlinkIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  LockIcon,
  PencilIcon,
  SquareSplitHorizontalIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'

import type { MenuAction } from '@/composites/menu-actions'
import type { TreeItemData } from '@/lib/tree-data'
import { fileManagerName } from '@/lib/platform'
import { parentOf } from '@/lib/tree-paths'
import type { ActiveDialog } from '@/state/dialogs'
import { NOTE_ACTIONS } from '@/state/document-runs'
import type { ClaimCreate, PathClaim } from '@/state/plugin-types'

/** What a New menu item makes: the plugin's claim, and the folder document
 *  entry its path ends in, which opening strips. */
export type FileCreate = ClaimCreate & { entry?: string }

/**
 * The actions on one row: what right-click on it, or ⋯ with it focused,
 * offers. Declarative; `on` is what each one does.
 */
export function rowActions({
  item,
  dirs,
  remote,
  vaultApp,
  heldBack,
  pluginActions,
  on,
}: {
  item: ItemInstance<TreeItemData>
  /** Every folder in the vault, for Move to. */
  dirs: readonly string[]
  remote: string | null
  vaultApp: (id: string) => boolean
  /** The row is a file the large-file gate held back: it offers the gate's
   *  two ways out. */
  heldBack: boolean
  /** What plugin claims add (`pluginRowActions`). */
  pluginActions: MenuAction[]
  on: {
    openBeside: (id: string) => void
    reveal: (id: string) => void
    copyPath: (id: string, form: 'relative' | 'absolute') => void
    copyLink: (id: string) => void
    rename: (id: string) => void
    shift: (id: string, by: -1 | 1) => void
    moveTo: (id: string, dest: string) => void
    remove: (id: string) => void
    createVaultApp: (id: string) => void
    commitAnyway: (id: string) => void
    keepLocal: (id: string) => void
  }
}): MenuAction[] {
  const id = item.getId()
  const siblings =
    item
      .getParent()
      ?.getChildren()
      .map((child) => child.getId()) ?? []
  const index = siblings.indexOf(id)
  const here = parentOf(id)
  const destinations = ['', ...dirs].filter(
    (dir) => dir !== here && dir !== id && !dir.startsWith(`${id}/`),
  )
  // A file or an app opens beside what is in front, as ⌥-click does; a
  // folder has nothing to open.
  const openable = !item.isFolder()
  // A Holi link opens a file on a teammate's machine, so a local file has
  // none (docs/features/holi-links.md).
  const linkable = openable && remote !== null && isHoliLinkable(id)
  const note = openable && /\.md$/i.test(id)
  const { copyLink, createVaultApp } = NOTE_ACTIONS
  return [
    ...(heldBack
      ? ([
          {
            kind: 'item',
            label: 'Commit anyway',
            icon: <UploadIcon aria-hidden="true" />,
            run: () => on.commitAnyway(id),
          },
          {
            kind: 'item',
            label: 'Keep local',
            icon: <LockIcon aria-hidden="true" />,
            run: () => on.keepLocal(id),
          },
          { kind: 'separator' },
        ] satisfies MenuAction[])
      : []),
    ...(openable
      ? ([
          {
            kind: 'item',
            label: 'Open in split view',
            icon: <SquareSplitHorizontalIcon aria-hidden="true" />,
            run: () => on.openBeside(id),
          },
          { kind: 'separator' },
          ...(note
            ? ([
                {
                  kind: 'item',
                  label: createVaultApp.label,
                  icon: <createVaultApp.icon aria-hidden="true" />,
                  disabled: !vaultApp(id),
                  run: () => on.createVaultApp(id),
                },
                { kind: 'separator' },
              ] satisfies MenuAction[])
            : []),
        ] satisfies MenuAction[])
      : []),
    {
      kind: 'item',
      label: `Open in ${fileManagerName()}`,
      icon: <FolderOpenIcon aria-hidden="true" />,
      run: () => on.reveal(id),
    },
    {
      kind: 'item',
      label: 'Copy relative path',
      icon: <FileSymlinkIcon aria-hidden="true" />,
      shortcut: '⌥⇧⌘C',
      run: () => on.copyPath(id, 'relative'),
    },
    {
      kind: 'item',
      label: 'Copy absolute path',
      icon: <HardDriveIcon aria-hidden="true" />,
      shortcut: '⌥⌘C',
      run: () => on.copyPath(id, 'absolute'),
    },
    ...(linkable
      ? ([
          {
            kind: 'item',
            label: copyLink.label,
            icon: <copyLink.icon aria-hidden="true" />,
            run: () => on.copyLink(id),
          },
        ] satisfies MenuAction[])
      : []),
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Rename',
      icon: <PencilIcon aria-hidden="true" />,
      shortcut: 'F2',
      run: () => on.rename(id),
    },
    {
      kind: 'item',
      label: 'Move up',
      icon: <ArrowUpIcon aria-hidden="true" />,
      disabled: index <= 0,
      run: () => on.shift(id, -1),
    },
    {
      kind: 'item',
      label: 'Move down',
      icon: <ArrowDownIcon aria-hidden="true" />,
      disabled: index < 0 || index >= siblings.length - 1,
      run: () => on.shift(id, 1),
    },
    {
      kind: 'sub',
      label: 'Move to',
      icon: <FolderInputIcon aria-hidden="true" />,
      items: destinations.map((dest) => ({
        kind: 'item',
        label: dest === '' ? 'Vault root' : dest,
        run: () => on.moveTo(id, dest),
      })),
    },
    ...pluginActions,
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Delete',
      icon: <Trash2Icon aria-hidden="true" />,
      destructive: true,
      run: () => on.remove(id),
    },
    { kind: 'separator' },
  ]
}

/** What a plugin's claim adds to a row's menu (an app's "Finish this app"),
 *  asked of each item's `when` as the menu opens. */
export function pluginRowActions({
  id,
  remote,
  claims,
  snapshot,
  openDialog,
}: {
  id: string
  remote: string | null
  claims: readonly PathClaim[]
  snapshot: VaultSnapshot
  openDialog: (dialog: ActiveDialog) => void
}): MenuAction[] {
  if (remote === null) return []
  const items = claims
    .filter((claim) => claim.match(id))
    .flatMap((claim) => claim.rowMenu ?? [])
    .filter((item) => item.when?.(id, snapshot) ?? true)
  if (items.length === 0) return []
  return [
    { kind: 'separator' },
    ...items.map((item): MenuAction => ({
      kind: 'item',
      label: item.label,
      run: () => item.run({ remote, path: id, openDialog }),
    })),
  ]
}

/**
 * The New menu: what can be made in a folder, a document and a folder first,
 * then each enabled claim's (New task, New Link, New app). The Files header's
 * + opens it alone; the ⋯ and right-click menus show it above `viewActions`.
 */
export function newActions({
  creates,
  remote,
  on,
}: {
  creates: readonly FileCreate[]
  remote: string | null
  on: {
    newNote: () => void
    newFolder: () => void
    make: (create: FileCreate) => void
  }
}): MenuAction[] {
  return [
    {
      kind: 'item',
      label: 'New document',
      icon: <FilePlusIcon aria-hidden="true" />,
      run: on.newNote,
    },
    {
      kind: 'item',
      label: 'New folder',
      icon: <FolderPlusIcon aria-hidden="true" />,
      run: on.newFolder,
    },
    ...creates.map((create): MenuAction => ({
      kind: 'item',
      label: create.label,
      icon: <create.icon aria-hidden={true} />,
      disabled: remote === null,
      run: () => on.make(create),
    })),
  ]
}

/** The view switches the ⋯ and right-click menus end with. */
export function viewActions({
  showTasks,
  showHidden,
  on,
}: {
  showTasks: boolean
  showHidden: boolean
  on: {
    toggleTasks: () => void
    toggleHidden: () => void
    collapseAll: () => void
  }
}): MenuAction[] {
  return [
    { kind: 'check', label: 'Show task files', checked: showTasks, toggle: on.toggleTasks },
    { kind: 'check', label: 'Show hidden files', checked: showHidden, toggle: on.toggleHidden },
    { kind: 'separator' },
    { kind: 'item', label: 'Collapse all', run: on.collapseAll },
  ]
}
