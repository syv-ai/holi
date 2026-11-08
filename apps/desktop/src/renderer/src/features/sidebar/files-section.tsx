import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  dragAndDropFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type DragTarget,
  type ItemInstance,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { toast } from 'sonner'
import { GITKEEP, holiLink, TASKS_CLAIM } from '@holi/shared'
import { cn } from '@/lib/cn'

import { ConfirmDialog } from '@/composites/confirm-dialog'
import { ContextMenuActions, DropdownMenuActions, type MenuAction } from '@/composites/menu-actions'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar'
import { useRequest } from '@/hooks/use-request'
import { useShortcutHandlers } from '@/hooks/use-shortcuts'
import { Tree, TreeDragLine, TreeItem, TreeItemLabel } from '@/components/ui/tree'
import { folderDocumentAt } from '@/state/folder-documents'
import { revealInFilesRequestAtom } from '@/state/reveal-in-files'
import { buildTreeData, ROOT_ID, type TreeItemData } from '@/lib/tree-data'
import { planMoveInto, planRenameFolder, type Move } from '@/lib/tree-actions'
import { basename, joinPath, parentOf } from '@/lib/tree-paths'
import { canMoveInto } from '@/lib/tree-view'
import { trpc } from '@/lib/trpc'
import { useTabDrag } from '@/features/shell/use-tab-drag'
import { openDialogAtom } from '@/state/dialogs'
import { startVaultAppAtom, vaultAppOfferAtom } from '@/state/document-runs'
import { openTabAtom, shellWorkspaceAtom } from '@/state/shell-tabs'
import { closeTabsWhere } from '@/state/shell-workspace'
import { parseTabKey, tabKey, tabPath } from '@/state/tab-descriptor'
import { shellTabForPathAtom } from '@/state/surfaces'
import { claimsAtom, folderClaimsAtom } from '@/state/plugins'
import { setTreeOrderAtom, treeOrderAtom } from '@/state/tree-order'
import {
  createFolderAtom,
  createNoteAtom,
  activeRemoteAtom,
  deleteManyAtom,
  heldBackAtom,
  ignoredPathsAtom,
  importFilesAtom,
  isUnsyncedPath,
  loadSnapshotAtom,
  moveNotesAtom,
  resolveHeldBackAtom,
  snapshotAtom,
  snapshotLoadedAtom,
  vaultsAtom,
} from '@/state/vaults'
import { activeVaultSettingsAtom } from '@/state/settings'
import { EllipsisIcon, PlusIcon } from 'lucide-react'
import { AskNameDialog } from './ask-name-dialog'
import {
  newActions,
  pluginRowActions,
  rowActions,
  viewActions,
  type FileCreate,
} from './file-menu-actions'
import { displayName, FileGlyph, HeldBackMark, RowHover } from './file-row'
import { attempt, freeName, useFiles } from './use-files'

const INDENT = 16

/**
 * The vault's files as a ReUI tree. Drag a row to reorder it among its
 * siblings (kept per machine, `state/tree-order.ts`) or into another folder
 * (a move that rewrites links); drop files from Finder anywhere on it to copy
 * them in. Right-click, or the ⋯ beside +, for the menu.
 */
export function FilesSection({
  activeId,
  onOpen,
  onMoved,
}: {
  activeId: string | null
  onOpen: (path: string) => void
  /** Moved files, so their open tabs follow them. */
  onMoved: (moves: Move[]) => void
}) {
  const files = useFiles()
  const store = useStore()
  const mounted = useRef(true)
  const loaded = useAtomValue(snapshotLoadedAtom)
  const order = useAtomValue(treeOrderAtom)
  const setOrder = useSetAtom(setTreeOrderAtom)
  const folderClaims = useAtomValue(folderClaimsAtom)
  const claims = useAtomValue(claimsAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const ignored = useAtomValue(ignoredPathsAtom)
  const heldBack = useAtomValue(heldBackAtom)
  const resolveHeldBack = useSetAtom(resolveHeldBackAtom)
  const sizeLimit = useAtomValue(activeVaultSettingsAtom)?.maxCommittedFileBytes ?? null
  /** Each held-back file, and every folder above one, with the files it
   *  holds: a closed folder carries their warning. */
  const heldUnder = useMemo(() => {
    const under = new Map<string, typeof heldBack>()
    for (const file of heldBack) {
      let path = file.path
      for (;;) {
        under.set(path, [...(under.get(path) ?? []), file])
        if (!path.includes('/')) break
        path = parentOf(path)
      }
    }
    return under
  }, [heldBack])
  const openDialog = useSetAtom(openDialogAtom)
  const vaultAppOffer = useAtomValue(vaultAppOfferAtom)
  const startVaultApp = useSetAtom(startVaultAppAtom)
  const openTab = useSetAtom(openTabAtom)
  /** The tab a row opens as: a plugin's folder document (a deck) is its
   *  surface, so the row, its drag and its highlight all go by that. */
  const tabForPath = useAtomValue(shellTabForPathAtom)
  /** What plugins make from the New menu, with the folder document each
   *  one's entry belongs to: a new app opens as the app, not its `index.html`. */
  const creates = claims.flatMap((claim) =>
    claim.create === undefined ? [] : [{ ...claim.create, entry: claim.folder?.entry }],
  )
  /** What a web address dropped from a browser is saved as: a link. */
  const urlCreate = creates.find((create) => create.fromUrl === true)
  /** A row's hover card, from the first claim on its path that draws one. */
  const hoverOf = (path: string) =>
    claims.find((claim) => claim.hover !== undefined && claim.match(path))?.hover
  /** A New menu item asking for its name first (a link's address), and
   *  the folder it goes in, while its dialog is open. */
  const [asking, setAsking] = useState<{
    create: FileCreate
    parent: string
  } | null>(null)
  const vaults = useAtomValue(vaultsAtom)
  const createNote = useSetAtom(createNoteAtom)
  const createFolder = useSetAtom(createFolderAtom)
  const moveNotes = useSetAtom(moveNotesAtom)
  const deleteMany = useSetAtom(deleteManyAtom)
  const setWorkspace = useSetAtom(shellWorkspaceAtom)
  const importFiles = useSetAtom(importFilesAtom)
  const loadSnapshot = useSetAtom(loadSnapshotAtom)
  /** The row a menu's Delete is asking about, until it is confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  /** The row the context menu was opened on, or null for the empty space. */
  const [menuTarget, setMenuTarget] = useState<string | null>(null)
  /** Set by a menu's Rename; the field opens once the menu has closed, so
   *  the menu handing focus back does not take it from the field. */
  const renameNext = useRef<string | null>(null)
  /** Set by a New item that opens a name field once it lands: the menu
   *  closing leaves focus alone, so it cannot take it from the field. */
  const namingNext = useRef(false)
  /** An asking New item waits until its menu has released focus before the
   *  dialog mounts; otherwise the closing menu can select text in its field. */
  const askingNext = useRef<{ create: FileCreate; parent: string } | null>(null)
  /** Rows that just landed (made, moved, renamed, dropped in, revealed): they
   *  rise in once, so the eye finds where they went. */
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set())
  /** The rows that landed last, waiting for the tree to show one: then they
   *  are selected and the first shown is focused and scrolled into view, its
   *  name field open when `name` is set (a row just made as Untitled).
   *  `snapshot` is the one current when they landed: once a newer one still
   *  shows none of them (a dotfile while hidden files are off), they are
   *  dropped rather than shown whenever they next appear. */
  const [landing, setLanding] = useState<{
    paths: string[]
    name: boolean
    remote: string | null
  } | null>(null)
  /** Every row the tree makes, moves or is asked to show lands here, the one
   *  place a row is brought into view. */
  const land = (paths: string[], { name = false } = {}) => {
    if (paths.length === 0 || !stillCurrent(files.remote)) return
    setArrived((current) => new Set([...current, ...paths]))
    setLanding({ paths, name, remote: files.remote })
  }
  const stillCurrent = useCallback(
    (remote: string | null) =>
      mounted.current && remote !== null && store.get(activeRemoteAtom) === remote,
    [store],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A plugin's folder document (a deck) opens as its surface, and its chevron
  // shows the files inside; an app's bundle is one document and only opens.
  const { data, browsable } = useMemo(() => {
    const browsable = new Set<string>()
    const data = buildTreeData(
      files.paths,
      files.dirs,
      (folder, has) => {
        const doc = folderDocumentAt(folderClaims, folder, has)
        if (doc !== null && doc.folder.surface !== 'app') browsable.add(folder)
        return doc !== null
      },
      order,
    )
    return { data, browsable }
  }, [files.paths, files.dirs, folderClaims, order])

  const folderOf = (item: ItemInstance<TreeItemData>) =>
    item.getId() === ROOT_ID ? '' : item.getId()

  async function move(moves: Move[]) {
    const remote = files.remote
    await moveNotes({ moves })
    if (stillCurrent(remote)) onMoved(moves)
  }

  /** Move `sources` into `dest`; the paths they land at, for the caller to land. */
  async function moveInto(sources: string[], dest: string): Promise<string[]> {
    if (!canMoveInto(sources, dest)) return []
    await move(planMoveInto(files.allPaths, sources, dest))
    return sources.map((source) => joinPath(dest, basename(source)))
  }

  /** Rows from this vault move; anything else is copied in from outside. */
  async function dropPaths(sources: string[], dest: string) {
    const root = vaults.find((vault) => vault.remote === files.remote)?.path
    const prefix = root ? `${root}/` : null
    const inside = prefix
      ? sources
          .filter((source) => source.startsWith(prefix))
          .map((source) => source.slice(prefix.length))
      : []
    const outside = sources.filter((source) => !prefix || !source.startsWith(prefix))
    const moved = inside.length > 0 ? await moveInto(inside, dest) : []
    const copied: string[] = []
    if (outside.length > 0) {
      const skipped = await importFiles(outside, dest)
      for (const { name, reason } of skipped) toast.error(`${name}: ${reason}`)
      const took = new Set(skipped.map((skip) => skip.name))
      for (const source of outside) {
        if (!took.has(basename(source))) copied.push(joinPath(dest, basename(source)))
      }
    }
    land([...moved, ...copied])
  }

  /** A new name in the same folder: a file moves, a folder moves what it
   *  holds. Either way links are rewritten and open tabs follow. */
  async function rename(item: ItemInstance<TreeItemData>, value: string) {
    const from = item.getId()
    const name = value.trim()
    if (name === '' || name === basename(from)) return
    if (name.includes('/')) {
      toast.error('Use a name without “/”.')
      return
    }
    const to = joinPath(parentOf(from), name)
    if (files.taken.has(to)) {
      toast.error(`“${name}” already exists in this folder. Choose another name.`)
      return
    }
    // The row keeps its place in a hand-made order, and a folder keeps its own.
    const parent = parentOf(from)
    const siblings = order[parent]
    if (siblings?.includes(from)) {
      setOrder(
        parent,
        siblings.map((id) => (id === from ? to : id)),
      )
    }
    const inside = order[from]
    if (inside) {
      setOrder(
        to,
        inside.map((id) => joinPath(to, id.slice(from.length + 1))),
      )
    }
    if (item.getItemData()?.isFolder !== true) {
      await move([{ from, to }])
    } else {
      const { moves } = planRenameFolder(files.allPaths, from, name)
      // An empty folder holds only its keep file.
      await move(
        moves.length > 0 ? moves : [{ from: `${from}/${GITKEEP}`, to: `${to}/${GITKEEP}` }],
      )
    }
    land([to])
  }

  async function onDrop(items: ItemInstance<TreeItemData>[], target: DragTarget<TreeItemData>) {
    const dest = folderOf(target.item)
    const sources = items.map((item) => item.getId())
    const moving = sources.filter((source) => parentOf(source) !== dest)
    const moved = moving.length > 0 ? await moveInto(moving, dest) : []
    // Between two rows: the rows land there in the folder's order.
    if ('insertionIndex' in target) {
      const landed = sources.map((source) => joinPath(dest, basename(source)))
      const siblings = target.item
        .getChildren()
        .map((child) => child.getId())
        .filter((id) => !sources.includes(id))
      siblings.splice(target.insertionIndex, 0, ...landed)
      setOrder(dest, siblings)
      land(landed)
    } else land(moved)
  }

  // A file's row drags as its tab too, beside the tree's own move.
  const tabDrag = useTabDrag()
  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    indent: INDENT,
    getItemName: (item) => item.getItemData()?.name ?? '',
    // An app's bundle is one document: it opens rather than expands. A deck
    // expands too, from its chevron (`onLabelClick`).
    isItemFolder: (item) =>
      item.getItemData()?.isFolder === true &&
      (item.getItemData()?.isDocument !== true || browsable.has(item.getId())),
    dataLoader: {
      getItem: (id) =>
        data[id] ?? {
          name: '',
          isFolder: false,
          isDocument: false,
          children: [],
        },
      getChildren: (id) => data[id]?.children ?? [],
    },
    onPrimaryAction: (item) => {
      if (!item.isFolder() || browsable.has(item.getId())) onOpen(item.getId())
    },
    canRename: (item) => item.getId() !== ROOT_ID,
    onRename: (item, value) =>
      void attempt(`rename “${item.getItemName()}”`, () => rename(item, value)),
    canReorder: true,
    onDrop: (items, target) => void attempt('move the files', () => onDrop(items, target)),
    canDropForeignDragObject: (dataTransfer) =>
      dataTransfer.types.includes('Files') ||
      (urlCreate !== undefined && dataTransfer.types.includes('text/uri-list')),
    onDropForeignDragObject: (dataTransfer, target) => {
      const url = droppedUrl(dataTransfer)
      if (url !== null) return dropUrl(url, folderOf(target.item))
      void attempt('add the files', () =>
        dropPaths(
          [...dataTransfer.files].map((file) => window.holi.pathForFile(file)),
          folderOf(target.item),
        ),
      )
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      expandAllFeature,
      renamingFeature,
    ],
  })

  // The snapshot is the source; a watcher tick replaces it, and the tree
  // re-reads its items.
  useEffect(() => {
    tree.rebuildTree()
  }, [data, tree])

  // Rows that landed: once the tree shows one, open its folders, select the
  // rows shown, and focus and scroll to the first (headless-tree's `scrollTo`
  // waits for the row to be drawn). Nothing here reads what the rebuild above
  // computes: expanding, selecting and focusing go by id.
  useEffect(() => {
    if (landing === null) return
    if (landing.remote !== files.remote || !stillCurrent(landing.remote)) {
      setLanding(null)
      return
    }
    const shown = landing.paths.filter((landed) => data[landed] !== undefined)
    const path = shown[0]
    if (path === undefined) {
      const present = new Set([
        ...snapshot.docs.map((doc) => doc.path),
        ...snapshot.files.map((file) => file.path),
        ...Object.values(snapshot.claimed).flatMap((set) => [
          ...set.items.map((item) => item.path),
          ...set.broken.map((item) => item.path),
        ]),
        ...snapshot.dirs,
      ])
      const taskPaths = new Set([
        ...(snapshot.claimed[TASKS_CLAIM]?.items.map((item) => item.path) ?? []),
        ...(snapshot.claimed[TASKS_CLAIM]?.broken.map((item) => item.path) ?? []),
      ])
      if (
        landing.paths.every(
          (landed) =>
            present.has(landed) &&
            ((taskPaths.has(landed) && !files.showTasks) ||
              (!files.showHidden && landed.split('/').some((part) => part.startsWith('.')))),
        )
      ) {
        setLanding(null)
      }
      return
    }
    setLanding(null)
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const folder = tree.getItemInstance(parts.slice(0, i).join('/'))
      if (!folder.isExpanded()) folder.expand()
    }
    const item = tree.getItemInstance(path)
    tree.setSelectedItems(shown)
    item.setFocused()
    void item.scrollTo({ block: 'nearest' })
    if (landing.name) item.startRenaming()
  }, [data, files.remote, files.showHidden, files.showTasks, landing, snapshot, stillCurrent, tree])

  // Reveal in Files (an app's card). The tree may mount with the request
  // already made (the sidebar was on Agents), so it catches up; a row the
  // tree does not have yet keeps the request waiting.
  useRequest(
    revealInFilesRequestAtom,
    ({ path }) => {
      if (data[path] === undefined) return false
      land([path])
    },
    { catchUp: true },
  )

  /** A deck's row: its chevron expands it, the rest opens it, where the
   *  tree's own press would do both. */
  function onLabelClick(item: ItemInstance<TreeItemData>, event: MouseEvent<HTMLElement>) {
    if (!browsable.has(item.getId()) || event.shiftKey || event.metaKey || event.ctrlKey) return
    event.stopPropagation()
    tree.setSelectedItems([item.getId()])
    item.setFocused()
    const chevron = event.currentTarget.querySelector('svg')?.getBoundingClientRect()
    if (chevron !== undefined && event.clientX <= chevron.right) {
      if (item.isExpanded()) item.collapse()
      else item.expand()
    } else onOpen(item.getId())
  }

  // The tree's own F2 renames its focused row; this one renames the selected
  // row from anywhere else, while the sidebar is open to show the field.
  const { open: sidebarOpen } = useSidebar()
  /** What a key acts on: the focused row while the tree has focus, else the
   *  row selected in it. */
  const keyedRow = (): string | null => {
    const inTree = tree.getElement()?.contains(document.activeElement) === true
    const id = (inTree ? tree.getFocusedItem() : tree.getSelectedItems()[0])?.getId()
    return id === undefined || id === ROOT_ID ? null : id
  }
  const copyKeyed = (form: 'relative' | 'absolute') => () => {
    const id = keyedRow()
    if (id !== null) copyPath(id, form)
  }
  useShortcutHandlers({
    'files.collapseAll': () => tree.collapseAll(),
    'files.copyPath': sidebarOpen ? copyKeyed('absolute') : undefined,
    'files.copyRelativePath': sidebarOpen ? copyKeyed('relative') : undefined,
    'files.rename': sidebarOpen
      ? () => {
          if (tree.getElement()?.contains(document.activeElement)) return
          const item = tree.getSelectedItems()[0]
          if (item && item.getId() !== ROOT_ID) item.startRenaming()
        }
      : undefined,
  })

  /** Make what a New menu item makes, named `name` in `parent`, and open
   *  it: a folder document as itself, not its entry file. `untitled` opens
   *  its name field, so typing names it. Throws the plugin's refusal. */
  async function made(
    create: FileCreate,
    parent: string,
    name: string,
    { untitled = false } = {},
  ): Promise<boolean> {
    const remote = files.remote
    if (remote === null) return false
    const path = await create.run({ remote, parent, name })
    if (!path || !stillCurrent(remote)) return false
    // What the plugin made is opened from a scan that has it: the watcher's
    // may come later, and a folder document opened before it would be taken
    // for a file that is not there.
    await loadSnapshot()
    if (!stillCurrent(remote)) return false
    const suffix = create.entry === undefined ? null : `/${create.entry}`
    const opened = suffix !== null && path.endsWith(suffix) ? path.slice(0, -suffix.length) : path
    land([opened], { name: untitled })
    onOpen(opened)
    return true
  }

  /** The web address a browser's drag carries, if that is all it carries. */
  function droppedUrl(data: DataTransfer): string | null {
    if (urlCreate === undefined || data.files.length > 0) return null
    const listed = data
      .getData('text/uri-list')
      .split(/\r?\n/)
      .find((line) => line !== '' && !line.startsWith('#'))
    const url = (listed ?? data.getData('text/plain')).trim()
    return /^https?:\/\//i.test(url) ? url : null
  }

  /** A web address dropped from a browser, saved as a link in `parent`. */
  function dropUrl(url: string, parent: string) {
    if (urlCreate === undefined) return
    void attempt('save the link', async () => {
      await made(urlCreate, parent, url)
    })
  }

  /** Finder drops on the empty space below the rows land at the root, and a
   *  browser's address is saved there as a link. */
  function onAreaDrop(event: DragEvent) {
    setDropping(false)
    if (event.defaultPrevented) return
    const url = droppedUrl(event.dataTransfer)
    if (url !== null) {
      event.preventDefault()
      dropUrl(url, '')
      return
    }
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    const sources = [...event.dataTransfer.files].map((file) => window.holi.pathForFile(file))
    void attempt('add the files', () => dropPaths(sources, ''))
  }

  /** A new Untitled document in `parent`, opened; `name` opens its name
   *  field (the New menu's), where the empty tree's button only opens it. */
  async function newNote(parent: string, { name = false } = {}): Promise<boolean> {
    const path = joinPath(parent, freeName(files.taken, parent, 'Untitled', '.md'))
    const remote = files.remote
    if (remote === null) return false
    await createNote(path)
    if (!stillCurrent(remote)) return false
    land([path], { name })
    onOpen(path)
    return true
  }

  /** A New menu item that lands with its name field open. The menu closing
   *  leaves focus for that field, so when nothing lands (a failure, a
   *  plugin's refusal) focus goes back to the tree instead of the page. */
  function naming(what: string, action: () => Promise<boolean>) {
    namingNext.current = true
    void attempt(what, async () => {
      let landed = false
      try {
        landed = await action()
      } finally {
        if (!landed) tree.updateDomFocus()
      }
    })
  }

  /** Put a row's path on the clipboard: as the vault has it, or main's
   *  absolute one. */
  function copyPath(path: string, form: 'relative' | 'absolute') {
    const remote = files.remote
    if (form === 'relative') void copyText(path, 'Path copied', path)
    else if (remote !== null)
      void copyText(trpc.files.absolutePath.query({ remote, path }), 'Path copied', path)
  }

  /** Swap a row with its neighbour, as the folder's hand-made order. */
  function shift(id: string, by: -1 | 1) {
    const parent = tree.getItemInstance(id).getParent()
    if (!parent) return
    const siblings = parent.getChildren().map((child) => child.getId())
    const from = siblings.indexOf(id)
    const to = from + by
    if (from < 0 || to < 0 || to >= siblings.length) return
    siblings.splice(from, 1)
    siblings.splice(to, 0, id)
    setOrder(folderOf(parent), siblings)
    land([id])
  }

  /** The actions on one row: what right-click on it, or ⋯ with it focused, offers. */
  function rowActionsOf(id: string): MenuAction[] {
    return rowActions({
      item: tree.getItemInstance(id),
      dirs: files.dirs,
      remote: files.remote,
      vaultApp: vaultAppOffer,
      heldBack: heldBack.some((file) => file.path === id),
      pluginActions: pluginRowActions({
        id,
        remote: files.remote,
        claims,
        snapshot,
        openDialog,
      }),
      on: {
        openBeside: (path) => openTab(tabForPath(path), { beside: true }),
        reveal: (path) => {
          const remote = files.remote
          if (remote !== null)
            void attempt(`show “${basename(path)}”`, async () => {
              await trpc.files.reveal.mutate({ remote, path })
            })
        },
        copyPath,
        copyLink: (path) => {
          if (files.remote !== null)
            void copyText(holiLink({ remote: files.remote, path }), 'Holi link copied', path)
        },
        rename: (path) => {
          renameNext.current = path
        },
        shift,
        moveTo: (path, dest) =>
          void attempt(`move “${basename(path)}”`, async () => land(await moveInto([path], dest))),
        remove: setDeleting,
        createVaultApp: (path) => {
          onOpen(path)
          void startVaultApp(path)
        },
        commitAnyway: (path) =>
          void attempt(`commit “${basename(path)}”`, () =>
            resolveHeldBack({ path, action: 'commit' }),
          ),
        keepLocal: (path) =>
          void attempt(`keep “${basename(path)}” local`, () =>
            resolveHeldBack({ path, action: 'keep' }),
          ),
      },
    })
  }

  /** Put `text` on the clipboard: a path (an absolute one is main's to build,
   *  in the platform's separators), or a Holi link for a teammate to click. */
  async function copyText(text: string | Promise<string>, done: string, path: string) {
    try {
      await navigator.clipboard.writeText(await text)
      toast.success(done, { description: basename(path) })
    } catch {
      toast.error('Copy failed', {
        description: 'The clipboard could not be written.',
      })
    }
  }

  /** Delete a file, or a folder (an app's bundle too) with everything in it,
   *  and close the tabs that showed any of it. Git keeps what it was. */
  function remove(id: string) {
    const folder = snapshot.dirs.includes(id)
    const inside = (path: string) => path === id || path.startsWith(`${id}/`)
    void attempt(`delete “${basename(id)}”`, async () => {
      await deleteMany(
        folder ? { paths: files.allPaths.filter(inside), folders: [id] } : { paths: [id] },
      )
      setWorkspace((ws) =>
        closeTabsWhere(ws, (key) => {
          const tab = parseTabKey(key)
          // A folder document's tab (a deck) holds its path as the surface's id.
          const folderDoc =
            tab?.kind === 'surface' && folderClaims.some((c) => c.folder.surface === tab.surface)
          const path = tabPath(key) ?? (folderDoc ? (tab.id ?? null) : null)
          return path !== null && inside(path)
        }),
      )
    })
  }

  /** The folder a menu's New items make things in: the folder row it was
   *  opened on, the folder of the file row it was opened on, or the root. */
  function newParent(target: string | null): string {
    if (target === null || target === ROOT_ID) return ''
    const item = tree.getItemInstance(target)
    return item.isFolder() && !browsable.has(target) ? target : parentOf(target)
  }

  /** The New menu for a menu opened on `target` (null: nothing picked).
   *  Each item lands what it made with its name field open, except one that
   *  asked its name in a dialog first (a link's address, a task's title). */
  const newActionsOf = (target: string | null): MenuAction[] => {
    const parent = newParent(target)
    return newActions({
      creates,
      remote: files.remote,
      on: {
        newNote: () => naming('create a document', () => newNote(parent, { name: true })),
        newFolder: () =>
          naming('create the folder', async () => {
            const name = joinPath(parent, freeName(files.taken, parent, 'New folder'))
            await createFolder(name)
            land([name], { name: true })
            return true
          }),
        make: (create) => {
          if (create.asksName === true) askingNext.current = { create, parent }
          else
            naming(`make the ${create.label.toLowerCase()}`, () =>
              made(
                create,
                parent,
                freeName(files.taken, parent, 'Untitled', '.app').replace(/\.app$/, ''),
                { untitled: true },
              ),
            )
        },
      },
    })
  }

  /** The view switches below the New menu in the ⋯ and right-click menus. */
  const viewMenu = viewActions({
    showTasks: files.showTasks,
    showHidden: files.showHidden,
    on: {
      toggleTasks: files.toggleTasks,
      toggleHidden: files.toggleHidden,
      collapseAll: () => tree.collapseAll(),
    },
  })

  /** Transfer focus ownership only after the closing menu has finished its
   *  own focus handling: to a requested dialog, a New item's name field, or a
   *  renamed row. */
  function openRenameOnClose(event: Event) {
    const ask = askingNext.current
    if (ask !== null) {
      askingNext.current = null
      event.preventDefault()
      setAsking(ask)
      return
    }
    if (namingNext.current) {
      namingNext.current = false
      event.preventDefault()
      return
    }
    const id = renameNext.current
    if (id === null) return
    renameNext.current = null
    event.preventDefault()
    tree.getItemInstance(id).startRenaming()
  }

  const empty = (data[ROOT_ID]?.children.length ?? 0) === 0
  // The row the ⋯ menu acts on: the one picked in the tree, never the
  // first row headless-tree focuses by default.
  const focused = empty ? null : (tree.getSelectedItems()[0] ?? null)

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>Files</SidebarGroupLabel>
      {/* What to add sits beside the menu, where the section's actions are,
          made where the ⋯ menu's New items make it. */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <SidebarGroupAction className="right-9">
                <PlusIcon aria-hidden="true" />
                <span className="sr-only">New</span>
              </SidebarGroupAction>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">New</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={openRenameOnClose}>
          <DropdownMenuActions actions={newActionsOf(focused?.getId() ?? null)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarGroupAction>
            <EllipsisIcon aria-hidden="true" />
            <span className="sr-only">More file actions</span>
          </SidebarGroupAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={openRenameOnClose}>
          {focused ? (
            <>
              <DropdownMenuLabel className="text-muted-foreground truncate text-xs font-normal">
                {focused.getItemName()}
              </DropdownMenuLabel>
              <DropdownMenuActions actions={rowActionsOf(focused.getId())} />
            </>
          ) : null}
          <DropdownMenuActions
            actions={[
              ...newActionsOf(focused?.getId() ?? null),
              { kind: 'separator' },
              ...viewMenu,
            ]}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The rows fade out at the tree's foot (the mask below). */}
      <div className="relative flex min-h-24 flex-1 flex-col">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              data-dropping={dropping || undefined}
              onDragOver={(event) => {
                const types = event.dataTransfer.types
                if (
                  !types.includes('Files') &&
                  !(urlCreate !== undefined && types.includes('text/uri-list'))
                )
                  return
                event.preventDefault()
                setDropping(true)
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false)
              }}
              onDrop={onAreaDrop}
              onContextMenu={(event) => {
                const row = (event.target as Element).closest('[data-slot=tree-item]')
                if (!row) setMenuTarget(null)
              }}
              // Rows fade out toward the foot; at the end of the list the
              // bottom padding lifts the last row clear of the fade.
              className={cn(
                'fade-foot relative min-h-0 flex-1 overflow-y-auto pb-12 scroll-pb-12 overscroll-contain rounded-md motion-respond',
                'data-dropping:bg-foreground/5 data-dropping:ring-ring/50 data-dropping:ring-1',
              )}
            >
              {!loaded ? (
                <div aria-busy="true" aria-label="Loading files">
                  {Array.from({ length: 6 }, (_, index) => (
                    <SidebarMenuSkeleton key={index} showIcon />
                  ))}
                </div>
              ) : empty ? (
                <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
                  <p className="text-muted-foreground text-xs">
                    No files yet. Drop some here, or start one.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void attempt('create a document', async () => void (await newNote('')))
                    }
                  >
                    <PlusIcon aria-hidden="true" />
                    New document
                  </Button>
                </div>
              ) : (
                <Tree indent={INDENT} tree={tree} className="relative">
                  {tree.getItems().map((item) => (
                    <TreeItem
                      key={item.getId()}
                      item={item}
                      aria-current={
                        tabKey(tabForPath(item.getId())) === activeId ? 'page' : undefined
                      }
                      onContextMenu={() => setMenuTarget(item.getId())}
                      {...tabDrag(
                        item.isFolder() && !browsable.has(item.getId())
                          ? null
                          : tabForPath(item.getId()),
                        {
                          alongside: true,
                        },
                      )}
                      onAnimationEnd={() =>
                        setArrived((current) => {
                          const next = new Set(current)
                          next.delete(item.getId())
                          return next
                        })
                      }
                      arrived={arrived.has(item.getId())}
                    >
                      <TreeItemLabel
                        onClick={(event) => onLabelClick(item, event)}
                        className={cn(
                          'hover:bg-foreground/5 bg-transparent',
                          tabKey(tabForPath(item.getId())) === activeId && 'bg-foreground/10',
                        )}
                      >
                        <RowHover card={hoverOf(item.getId())} path={item.getId()}>
                          {/* A file that never syncs is dimmed, on the
                              contents so a selection behind stays solid. */}
                          <span
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2',
                              isUnsyncedPath(ignored, item.getId()) && 'opacity-60',
                            )}
                          >
                            <FileGlyph item={item} />
                            {item.isRenaming() ? (
                              <Input
                                {...item.getRenameInputProps()}
                                autoFocus
                                aria-label={`Rename ${item.getItemName()}`}
                                // The name without its extension, ready to type over.
                                onFocus={(event) => {
                                  const value = event.currentTarget.value
                                  const dot = value.lastIndexOf('.')
                                  event.currentTarget.setSelectionRange(
                                    0,
                                    (item.isFolder() && !browsable.has(item.getId())) || dot <= 0
                                      ? value.length
                                      : dot,
                                  )
                                }}
                                onClick={(event) => event.stopPropagation()}
                                className="-my-1.5"
                              />
                            ) : (
                              <span className="truncate">{displayName(item)}</span>
                            )}
                            {/* An open folder leaves the warning to its files. */}
                            <HeldBackMark
                              held={item.isExpanded() ? undefined : heldUnder.get(item.getId())}
                              limit={sizeLimit}
                            />
                          </span>
                        </RowHover>
                      </TreeItemLabel>
                    </TreeItem>
                  ))}
                  <TreeDragLine />
                </Tree>
              )}
            </div>
          </ContextMenuTrigger>

          <ContextMenuContent className="w-52" onCloseAutoFocus={openRenameOnClose}>
            {menuTarget !== null ? <ContextMenuActions actions={rowActionsOf(menuTarget)} /> : null}
            <ContextMenuActions
              actions={[...newActionsOf(menuTarget), { kind: 'separator' }, ...viewMenu]}
            />
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        size="sm"
        destructive
        title={`Delete “${deleting === null ? '' : basename(deleting)}”?`}
        description={`${
          deleting !== null && snapshot.dirs.includes(deleting)
            ? 'It and everything in it leave the vault for everyone it syncs with.'
            : 'It leaves the vault for everyone it syncs with.'
        } Its history keeps the last version.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting !== null) remove(deleting)
        }}
      />

      <AskNameDialog
        asking={asking}
        onClose={() => setAsking(null)}
        onMake={(name) =>
          asking === null
            ? Promise.resolve()
            : made(asking.create, asking.parent, name).then(() => undefined)
        }
      />
    </SidebarGroup>
  )
}
