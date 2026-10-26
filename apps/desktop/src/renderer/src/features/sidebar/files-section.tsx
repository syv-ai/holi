import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  dragAndDropFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type DragTarget,
  type ItemInstance,
} from "@headless-tree/core"
import { useTree } from "@headless-tree/react"
import { toast } from "sonner"
import {
  GITKEEP,
  holiLink,
  isHiddenPath,
  isHoliLinkable,
  TASKS_CLAIM,
} from "@holi/shared"
import { cn } from "@/lib/cn"
import { ARRIVE } from "./documents-nav"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FileType, getFileType } from "@/components/reui/file-type"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar"
import { useShortcutHandlers } from "@/state/shortcuts"
import {
  Tree,
  TreeDragLine,
  TreeItem,
  TreeItemLabel,
} from "@/components/reui/tree"
import { folderDocumentAt } from "@/lib/folder-documents"
import { revealInFilesRequestAtom } from "@/state/reveal-in-files"
import { buildTreeData, ROOT_ID, type TreeItemData } from "@/lib/tree-data"
import { planMoveInto, planRenameFolder, type Move } from "@/lib/tree-actions"
import { basename, joinPath, parentOf } from "@/lib/tree-paths"
import { canMoveInto } from "@/lib/tree-view"
import { useTabDrag } from "../shell/use-tab-drag"
import { openDialogAtom } from "@/state/dialogs"
import { openTabAtom, shellWorkspaceAtom } from "@/state/shell-tabs"
import { closeTabsWhere } from "@/state/shell-workspace"
import { tabForPath, tabPath } from "@/state/tab-descriptor"
import type { ClaimCreate } from "@/plugin-api/types"
import { claimsAtom, folderClaimsAtom } from "@/state/plugins"
import { createTaskAtom } from "@/state/tasks"
import { setTreeOrderAtom, treeOrderAtom } from "@/state/tree-order"
import {
  activeRemoteAtom,
  createFolderAtom,
  createNoteAtom,
  deleteManyAtom,
  importFilesAtom,
  moveNotesAtom,
  showHiddenByVaultAtom,
  showTasksByVaultAtom,
  snapshotAtom,
  snapshotLoadedAtom,
  vaultsAtom,
} from "@/state/vaults"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  FolderInputIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LinkIcon,
  ListChecksIcon,
  PencilIcon,
  PlusIcon,
  SquareSplitHorizontalIcon,
  Trash2Icon,
} from "lucide-react"

const INDENT = 16

/** `base`, then `base 2`, `base 3`… : the first name the folder does not hold. */
function freeName(
  taken: ReadonlySet<string>,
  parent: string,
  base: string,
  ext = ""
): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} ${n}${ext}`
    if (!taken.has(joinPath(parent, name))) return name
  }
}

/**
 * The paths the tree shows, and every path it can act on: documents, other
 * files and claimed files (tasks only while "show task files" is on), minus
 * dot paths unless "show hidden files" is on.
 */
function useFiles() {
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const [hiddenByVault, setHiddenByVault] = useAtom(showHiddenByVaultAtom)
  const [tasksByVault, setTasksByVault] = useAtom(showTasksByVaultAtom)
  const showHidden = remote !== null && hiddenByVault[remote] === true
  const showTasks = remote !== null && tasksByVault[remote] === true

  const docPaths = useMemo(
    () => [
      ...snapshot.docs.map((doc) => doc.path),
      ...snapshot.files.map((file) => file.path),
      ...Object.entries(snapshot.claimed).flatMap(([id, set]) =>
        id === TASKS_CLAIM && !showTasks
          ? []
          : [
              ...set.items.map((item) => item.path),
              ...set.broken.map((item) => item.path),
            ]
      ),
    ],
    [snapshot, showTasks]
  )
  // Everything a rename or a new name must not collide with, or must carry
  // along: task files too, shown or not.
  const allPaths = useMemo(
    () => [
      ...snapshot.docs.map((doc) => doc.path),
      ...snapshot.files.map((file) => file.path),
      ...Object.values(snapshot.claimed).flatMap((set) => [
        ...set.items.map((item) => item.path),
        ...set.broken.map((item) => item.path),
      ]),
    ],
    [snapshot]
  )
  // Memoised: the tree rebuilds whenever these change identity, and a
  // rebuild re-renders this component.
  const paths = useMemo(
    () =>
      showHidden ? docPaths : docPaths.filter((path) => !isHiddenPath(path)),
    [docPaths, showHidden]
  )
  const dirs = useMemo(
    () =>
      showHidden
        ? snapshot.dirs
        : snapshot.dirs.filter((dir) => !isHiddenPath(dir)),
    [snapshot.dirs, showHidden]
  )

  return {
    remote,
    docPaths,
    allPaths,
    paths,
    dirs,
    taken: new Set([...allPaths, ...snapshot.dirs]),
    showHidden,
    showTasks,
    toggleHidden: () =>
      remote !== null &&
      setHiddenByVault({ ...hiddenByVault, [remote]: !showHidden }),
    toggleTasks: () =>
      remote !== null &&
      setTasksByVault({ ...tasksByVault, [remote]: !showTasks }),
  }
}

/** The one way a failed vault action is reported: what failed, and what to do. */
async function attempt(what: string, action: () => Promise<void>) {
  try {
    await action()
  } catch {
    toast.error(
      `Couldn't ${what}. Check that the vault is reachable, then try again.`
    )
  }
}

/** A new, uniquely named note at the vault's root, for New document and +. */
export function useNewDocument(onCreated: (path: string) => void) {
  const { taken } = useFiles()
  const createNote = useSetAtom(createNoteAtom)
  return () =>
    attempt("create a document", async () => {
      const path = freeName(taken, "", "Untitled", ".md")
      await createNote(path)
      onCreated(path)
    })
}

/**
 * A menu written once and drawn twice: as the tree's right-click menu and as
 * the ⋯ button's dropdown, which is the keyboard's way to the same actions.
 */
type MenuAction =
  | {
      kind: "item"
      label: string
      icon?: ReactNode
      shortcut?: string
      disabled?: boolean
      destructive?: boolean
      run: () => void
    }
  | { kind: "check"; label: string; checked: boolean; toggle: () => void }
  | { kind: "sub"; label: string; icon?: ReactNode; items: MenuAction[] }
  | { kind: "separator" }

function ContextMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) => {
    switch (action.kind) {
      case "separator":
        return <ContextMenuSeparator key={index} />
      case "check":
        return (
          <ContextMenuCheckboxItem
            key={index}
            checked={action.checked}
            onCheckedChange={action.toggle}
          >
            {action.label}
          </ContextMenuCheckboxItem>
        )
      case "sub":
        return (
          <ContextMenuSub key={index}>
            <ContextMenuSubTrigger>
              {action.icon}
              {action.label}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-72 w-52 overflow-y-auto">
              <ContextMenuActions actions={action.items} />
            </ContextMenuSubContent>
          </ContextMenuSub>
        )
      case "item":
        return (
          <ContextMenuItem
            key={index}
            variant={action.destructive ? "destructive" : "default"}
            disabled={action.disabled}
            onSelect={action.run}
          >
            {action.icon}
            {action.label}
            {action.shortcut ? (
              <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>
            ) : null}
          </ContextMenuItem>
        )
    }
  })
}

function DropdownMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) => {
    switch (action.kind) {
      case "separator":
        return <DropdownMenuSeparator key={index} />
      case "check":
        return (
          <DropdownMenuCheckboxItem
            key={index}
            checked={action.checked}
            onCheckedChange={action.toggle}
          >
            {action.label}
          </DropdownMenuCheckboxItem>
        )
      case "sub":
        return (
          <DropdownMenuSub key={index}>
            <DropdownMenuSubTrigger>
              {action.icon}
              {action.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
              <DropdownMenuActions actions={action.items} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case "item":
        return (
          <DropdownMenuItem
            key={index}
            variant={action.destructive ? "destructive" : "default"}
            disabled={action.disabled}
            onSelect={action.run}
          >
            {action.icon}
            {action.label}
            {action.shortcut ? (
              <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )
    }
  })
}

/**
 * The vault's files as a ReUI tree. Drag a row to reorder it among its
 * siblings (kept per machine, `state/tree-order.ts`) or into another folder
 * (a move that rewrites links); drop files from Finder anywhere on it to copy
 * them in. Right-click, or the ⋯ beside +, for the menu.
 */
/** The last Reveal in Files the tree answered (`revealInFilesRequestAtom`). */
let revealedSeq = 0

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
  const loaded = useAtomValue(snapshotLoadedAtom)
  const order = useAtomValue(treeOrderAtom)
  const setOrder = useSetAtom(setTreeOrderAtom)
  const folderClaims = useAtomValue(folderClaimsAtom)
  const claims = useAtomValue(claimsAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const openDialog = useSetAtom(openDialogAtom)
  const openTab = useSetAtom(openTabAtom)
  /** What plugins make from the New menu, with the folder document each
   *  one's entry belongs to: a new app opens as the app, not its `index.html`. */
  const creates = claims.flatMap((claim) =>
    claim.create === undefined
      ? []
      : [{ ...claim.create, entry: claim.folder?.entry }]
  )
  /** What a web address dropped from a browser is saved as: a link. */
  const urlCreate = creates.find((create) => create.fromUrl === true)
  /** A row's hover card, from the first claim on its path that draws one. */
  const hoverOf = (path: string) =>
    claims.find((claim) => claim.hover !== undefined && claim.match(path))
      ?.hover
  /** A New menu item asking for its name first (a link's address), and
   *  the folder it goes in, while its dialog is open. */
  const [asking, setAsking] = useState<{
    create: ClaimCreate & { entry?: string }
    parent: string
  } | null>(null)
  const vaults = useAtomValue(vaultsAtom)
  const createNote = useSetAtom(createNoteAtom)
  const createFolder = useSetAtom(createFolderAtom)
  const createTask = useSetAtom(createTaskAtom)
  const moveNotes = useSetAtom(moveNotesAtom)
  const deleteMany = useSetAtom(deleteManyAtom)
  const setWorkspace = useSetAtom(shellWorkspaceAtom)
  const importFiles = useSetAtom(importFilesAtom)
  /** The row a menu's Delete is asking about, until it is confirmed. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  /** The row the context menu was opened on, or null for the empty space. */
  const [menuTarget, setMenuTarget] = useState<string | null>(null)
  /** Set by a menu's Rename; the field opens once the menu has closed, so
   *  the menu handing focus back does not take it from the field. */
  const renameNext = useRef<string | null>(null)
  /** Rows that just landed (made, moved, renamed, dropped in): they fade in
   *  once, so the eye finds where they went. */
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set())
  const markArrived = (paths: string[]) =>
    setArrived((current) => new Set([...current, ...paths]))

  const data = useMemo(
    () =>
      buildTreeData(
        files.paths,
        files.dirs,
        (folder, has) => folderDocumentAt(folderClaims, folder, has) !== null,
        order
      ),
    [files.paths, files.dirs, folderClaims, order]
  )

  const folderOf = (item: ItemInstance<TreeItemData>) =>
    item.getId() === ROOT_ID ? "" : item.getId()

  async function move(moves: Move[]) {
    await moveNotes({ moves })
    onMoved(moves)
  }

  /** Move `sources` into `dest`, the rows landing there visibly. */
  async function moveInto(sources: string[], dest: string) {
    if (!canMoveInto(sources, dest)) return
    await move(planMoveInto(files.allPaths, sources, dest))
    markArrived(sources.map((source) => joinPath(dest, basename(source))))
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
    const outside = sources.filter(
      (source) => !prefix || !source.startsWith(prefix)
    )
    if (inside.length > 0) await moveInto(inside, dest)
    if (outside.length > 0) {
      const skipped = await importFiles(outside, dest)
      for (const { name, reason } of skipped) toast.error(`${name}: ${reason}`)
      const took = new Set(skipped.map((skip) => skip.name))
      markArrived(
        outside
          .map((source) => basename(source))
          .filter((name) => !took.has(name))
          .map((name) => joinPath(dest, name))
      )
    }
  }

  /** A new name in the same folder: a file moves, a folder moves what it
   *  holds. Either way links are rewritten and open tabs follow. */
  async function rename(item: ItemInstance<TreeItemData>, value: string) {
    const from = item.getId()
    const name = value.trim()
    if (name === "" || name === basename(from)) return
    if (name.includes("/")) {
      toast.error("Use a name without “/”.")
      return
    }
    const to = joinPath(parentOf(from), name)
    if (files.taken.has(to)) {
      toast.error(
        `“${name}” already exists in this folder. Choose another name.`
      )
      return
    }
    // The row keeps its place in a hand-made order, and a folder keeps its own.
    const parent = parentOf(from)
    const siblings = order[parent]
    if (siblings?.includes(from)) {
      setOrder(
        parent,
        siblings.map((id) => (id === from ? to : id))
      )
    }
    const inside = order[from]
    if (inside) {
      setOrder(
        to,
        inside.map((id) => joinPath(to, id.slice(from.length + 1)))
      )
    }
    if (item.getItemData()?.isFolder !== true) {
      await move([{ from, to }])
    } else {
      const { moves } = planRenameFolder(files.allPaths, from, name)
      // An empty folder holds only its keep file.
      await move(
        moves.length > 0
          ? moves
          : [{ from: `${from}/${GITKEEP}`, to: `${to}/${GITKEEP}` }]
      )
    }
    markArrived([to])
  }

  async function onDrop(
    items: ItemInstance<TreeItemData>[],
    target: DragTarget<TreeItemData>
  ) {
    const dest = folderOf(target.item)
    const sources = items.map((item) => item.getId())
    const moving = sources.filter((source) => parentOf(source) !== dest)
    if (moving.length > 0) await moveInto(moving, dest)
    // Between two rows: the moved rows land there in the folder's order.
    if ("insertionIndex" in target) {
      const landed = sources.map((source) => joinPath(dest, basename(source)))
      const siblings = target.item
        .getChildren()
        .map((child) => child.getId())
        .filter((id) => !sources.includes(id))
      siblings.splice(target.insertionIndex, 0, ...landed)
      setOrder(dest, siblings)
    }
  }

  // A file's row drags as its tab too, beside the tree's own move.
  const tabDrag = useTabDrag()
  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    indent: INDENT,
    getItemName: (item) => item.getItemData()?.name ?? "",
    // An app's bundle is one document: it opens rather than expands.
    isItemFolder: (item) =>
      item.getItemData()?.isFolder === true &&
      item.getItemData()?.isDocument !== true,
    dataLoader: {
      getItem: (id) =>
        data[id] ?? {
          name: "",
          isFolder: false,
          isDocument: false,
          children: [],
        },
      getChildren: (id) => data[id]?.children ?? [],
    },
    onPrimaryAction: (item) => {
      if (!item.isFolder()) onOpen(item.getId())
    },
    canRename: (item) => item.getId() !== ROOT_ID,
    onRename: (item, value) =>
      void attempt(`rename “${item.getItemName()}”`, () => rename(item, value)),
    canReorder: true,
    onDrop: (items, target) =>
      void attempt("move the files", () => onDrop(items, target)),
    canDropForeignDragObject: (dataTransfer) =>
      dataTransfer.types.includes("Files") ||
      (urlCreate !== undefined && dataTransfer.types.includes("text/uri-list")),
    onDropForeignDragObject: (dataTransfer, target) => {
      const url = droppedUrl(dataTransfer)
      if (url !== null) return dropUrl(url, folderOf(target.item))
      void attempt("add the files", () =>
        dropPaths(
          [...dataTransfer.files].map((file) => window.holi.pathForFile(file)),
          folderOf(target.item)
        )
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

  // Reveal in Files (an app's card): open the row's folders, then select it,
  // focus it and scroll it into view once the tree has drawn them.
  // The tree may mount with the request already made (the sidebar was on
  // Agents), so what was handled is kept outside it.
  const revealRequest = useAtomValue(revealInFilesRequestAtom)
  useEffect(() => {
    if (revealRequest === null || revealRequest.seq <= revealedSeq) return
    if (data[revealRequest.path] === undefined) return
    revealedSeq = revealRequest.seq
    const path = revealRequest.path
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++) {
      tree.getItemInstance(parts.slice(0, i).join("/")).expand()
    }
    const frame = requestAnimationFrame(() => {
      const item = tree.getItemInstance(path)
      item.setFocused()
      tree.setSelectedItems([path])
      void item.scrollTo({ block: "nearest" })
      markArrived([path])
    })
    return () => cancelAnimationFrame(frame)
  }, [revealRequest, data, tree])

  // The tree's own F2 renames its focused row; this one renames the selected
  // row from anywhere else, while the sidebar is open to show the field.
  const { open: sidebarOpen } = useSidebar()
  useShortcutHandlers({
    "files.collapseAll": () => tree.collapseAll(),
    "files.rename": sidebarOpen
      ? () => {
          if (tree.getElement()?.contains(document.activeElement)) return
          const item = tree.getSelectedItems()[0]
          if (item && item.getId() !== ROOT_ID) item.startRenaming()
        }
      : undefined,
  })

  /** Make what a New menu item makes, named `name` in `parent`, and open
   *  it: a folder document as itself, not its entry file. Throws the
   *  plugin's refusal. */
  async function made(
    create: ClaimCreate & { entry?: string },
    parent: string,
    name: string
  ) {
    if (files.remote === null) return
    const path = await create.run({ remote: files.remote, parent, name })
    if (!path) return
    const suffix = create.entry === undefined ? null : `/${create.entry}`
    const opened =
      suffix !== null && path.endsWith(suffix)
        ? path.slice(0, -suffix.length)
        : path
    reveal(parent)
    markArrived([opened])
    onOpen(opened)
  }

  /** The web address a browser's drag carries, if that is all it carries. */
  function droppedUrl(data: DataTransfer): string | null {
    if (urlCreate === undefined || data.files.length > 0) return null
    const listed = data
      .getData("text/uri-list")
      .split(/\r?\n/)
      .find((line) => line !== "" && !line.startsWith("#"))
    const url = (listed ?? data.getData("text/plain")).trim()
    return /^https?:\/\//i.test(url) ? url : null
  }

  /** A web address dropped from a browser, saved as a link in `parent`. */
  function dropUrl(url: string, parent: string) {
    if (urlCreate === undefined) return
    void attempt("save the link", () => made(urlCreate, parent, url))
  }

  /** Finder drops on the empty space below the rows land at the root, and a
   *  browser's address is saved there as a link. */
  function onAreaDrop(event: DragEvent) {
    setDropping(false)
    if (event.defaultPrevented) return
    const url = droppedUrl(event.dataTransfer)
    if (url !== null) {
      event.preventDefault()
      dropUrl(url, "")
      return
    }
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    const sources = [...event.dataTransfer.files].map((file) =>
      window.holi.pathForFile(file)
    )
    void attempt("add the files", () => dropPaths(sources, ""))
  }

  function newNote() {
    void attempt("create a document", async () => {
      const name = freeName(files.taken, "", "Untitled", ".md")
      await createNote(name)
      markArrived([name])
      onOpen(name)
    })
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
    markArrived([id])
  }

  /** The actions on one row: what right-click on it, or ⋯ with it focused, offers. */
  function rowActions(id: string): MenuAction[] {
    const item = tree.getItemInstance(id)
    const parent = item.getParent()
    const siblings = parent?.getChildren().map((child) => child.getId()) ?? []
    const index = siblings.indexOf(id)
    const here = parentOf(id)
    const destinations = ["", ...files.dirs].filter(
      (dir) => dir !== here && dir !== id && !dir.startsWith(`${id}/`)
    )
    // A file or an app opens beside what is in front, as ⌥-click does; a
    // folder has nothing to open.
    const openable = !item.isFolder()
    // A Holi link opens a file on a teammate's machine, so a local file has
    // none (docs/features/holi-links.md).
    const linkable = openable && files.remote !== null && isHoliLinkable(id)
    return [
      ...(openable
        ? ([
            {
              kind: "item",
              label: "Open in split view",
              icon: <SquareSplitHorizontalIcon aria-hidden="true" />,
              run: () => openTab(tabForPath(id), { beside: true }),
            },
            ...(linkable
              ? ([
                  {
                    kind: "item",
                    label: "Copy Holi link",
                    icon: <LinkIcon aria-hidden="true" />,
                    run: () => void copyLink(id),
                  },
                ] satisfies MenuAction[])
              : []),
            { kind: "separator" },
          ] satisfies MenuAction[])
        : []),
      {
        kind: "item",
        label: "Rename",
        icon: <PencilIcon aria-hidden="true" />,
        shortcut: "F2",
        run: () => {
          renameNext.current = id
        },
      },
      {
        kind: "item",
        label: "Move up",
        icon: <ArrowUpIcon aria-hidden="true" />,
        disabled: index <= 0,
        run: () => shift(id, -1),
      },
      {
        kind: "item",
        label: "Move down",
        icon: <ArrowDownIcon aria-hidden="true" />,
        disabled: index < 0 || index >= siblings.length - 1,
        run: () => shift(id, 1),
      },
      {
        kind: "sub",
        label: "Move to",
        icon: <FolderInputIcon aria-hidden="true" />,
        items: destinations.map((dest) => ({
          kind: "item",
          label: dest === "" ? "Vault root" : dest,
          run: () =>
            void attempt(`move “${basename(id)}”`, () => moveInto([id], dest)),
        })),
      },
      ...pluginRowActions(id),
      { kind: "separator" },
      {
        kind: "item",
        label: "Delete",
        icon: <Trash2Icon aria-hidden="true" />,
        destructive: true,
        run: () => setDeleting(id),
      },
      { kind: "separator" },
    ]
  }

  /** Put `path`'s Holi link on the clipboard, for a teammate to click. */
  async function copyLink(path: string) {
    const remote = files.remote
    if (remote === null) return
    try {
      await navigator.clipboard.writeText(holiLink({ remote, path }))
      toast.success("Holi link copied", { description: basename(path) })
    } catch {
      toast.error("Copy failed", {
        description: "The clipboard could not be written.",
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
        folder
          ? { paths: files.allPaths.filter(inside), folders: [id] }
          : { paths: [id] }
      )
      setWorkspace((ws) =>
        closeTabsWhere(ws, (key) => {
          const path = tabPath(key)
          return path !== null && inside(path)
        })
      )
    })
  }

  /** What a plugin's claim adds to this row's menu (an app's "Finish this
   *  app"), asked of each item's `when` as the menu opens. */
  function pluginRowActions(id: string): MenuAction[] {
    const remote = files.remote
    if (remote === null) return []
    const items = claims
      .filter((claim) => claim.match(id))
      .flatMap((claim) => claim.rowMenu ?? [])
      .filter((item) => item.when?.(id, snapshot) ?? true)
    if (items.length === 0) return []
    return [
      { kind: "separator" },
      ...items.map((item): MenuAction => ({
        kind: "item",
        label: item.label,
        run: () => item.run({ remote, path: id, openDialog }),
      })),
    ]
  }

  /** The folder a menu's New items make things in: the folder row it was
   *  opened on, the folder of the file row it was opened on, or the root. */
  function newParent(target: string | null): string {
    if (target === null || target === ROOT_ID) return ""
    const item = tree.getItemInstance(target)
    return item.isFolder() ? target : parentOf(target)
  }

  /** Shows what was just made inside `parent`, which may be collapsed. */
  function reveal(parent: string) {
    if (parent !== "") tree.getItemInstance(parent).expand()
  }

  const newActions = (target: string | null): MenuAction[] => {
    const parent = newParent(target)
    return [
      {
        kind: "item",
        label: "New folder",
        icon: <FolderPlusIcon aria-hidden="true" />,
        run: () =>
          void attempt("create the folder", async () => {
            const name = joinPath(
              parent,
              freeName(files.taken, parent, "New folder")
            )
            await createFolder(name)
            reveal(parent)
            markArrived([name])
          }),
      },
      {
        kind: "item",
        label: "New task",
        icon: <ListChecksIcon aria-hidden="true" />,
        run: () =>
          void attempt("create the task", async () => {
            const path = await createTask({
              title: "Untitled task",
              status: "todo",
              folder: parent,
            })
            if (path) onOpen(path)
          }),
      },
      ...creates.map((create): MenuAction => ({
        kind: "item",
        label: create.label,
        icon: <create.icon aria-hidden={true} />,
        disabled: files.remote === null,
        run: () =>
          create.asksName === true
            ? setAsking({ create, parent })
            : void attempt(`make the ${create.label.toLowerCase()}`, () =>
                made(
                  create,
                  parent,
                  freeName(files.taken, parent, "Untitled", ".app").replace(
                    /\.app$/,
                    ""
                  )
                )
              ),
      })),
      { kind: "separator" },
      {
        kind: "check",
        label: "Show task files",
        checked: files.showTasks,
        toggle: files.toggleTasks,
      },
      {
        kind: "check",
        label: "Show hidden files",
        checked: files.showHidden,
        toggle: files.toggleHidden,
      },
      { kind: "separator" },
      { kind: "item", label: "Collapse all", run: () => tree.collapseAll() },
    ]
  }

  /** A menu closing on Rename opens the field instead of taking focus back. */
  function openRenameOnClose(event: Event) {
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
    <SidebarGroup className="min-h-0 flex-1 px-2 pb-0">
      <SidebarGroupLabel>Files</SidebarGroupLabel>
      {/* New document sits beside the menu, where the section's actions are. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarGroupAction className="right-9" onClick={newNote}>
            <PlusIcon aria-hidden="true" />
            <span className="sr-only">New document</span>
          </SidebarGroupAction>
        </TooltipTrigger>
        <TooltipContent side="bottom">New document</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarGroupAction>
            <EllipsisIcon aria-hidden="true" />
            <span className="sr-only">More file actions</span>
          </SidebarGroupAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56"
          onCloseAutoFocus={openRenameOnClose}
        >
          {focused ? (
            <>
              <DropdownMenuLabel className="text-muted-foreground truncate text-xs font-normal">
                {focused.getItemName()}
              </DropdownMenuLabel>
              <DropdownMenuActions actions={rowActions(focused.getId())} />
            </>
          ) : null}
          <DropdownMenuActions actions={newActions(focused?.getId() ?? null)} />
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
                  !types.includes("Files") &&
                  !(urlCreate !== undefined && types.includes("text/uri-list"))
                )
                  return
                event.preventDefault()
                setDropping(true)
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
                  setDropping(false)
              }}
              onDrop={onAreaDrop}
              onContextMenu={(event) => {
                const row = (event.target as Element).closest(
                  "[data-slot=tree-item]"
                )
                if (!row) setMenuTarget(null)
              }}
              // Rows fade out toward the foot; at the end of the list the
              // bottom padding lifts the last row clear of the fade.
              style={{
                maskImage:
                  "linear-gradient(to bottom, #000 calc(100% - 3rem), transparent calc(100% - 1rem))",
              }}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-auto pb-12 overscroll-contain rounded-md transition-colors",
                "data-dropping:bg-foreground/5 data-dropping:ring-ring/50 data-dropping:ring-1"
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
                  <Button variant="outline" size="sm" onClick={newNote}>
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
                        item.getId() === activeId ? "page" : undefined
                      }
                      onContextMenu={() => setMenuTarget(item.getId())}
                      {...tabDrag(
                        item.isFolder() ? null : tabForPath(item.getId()),
                        { alongside: true }
                      )}
                      onAnimationEnd={() =>
                        setArrived((current) => {
                          const next = new Set(current)
                          next.delete(item.getId())
                          return next
                        })
                      }
                      className={cn(
                        arrived.has(item.getId()) &&
                          cn(
                            ARRIVE,
                            "slide-in-from-top-1 motion-reduce:slide-in-from-top-0"
                          )
                      )}
                    >
                      <TreeItemLabel
                        className={cn(
                          "hover:bg-foreground/5 bg-transparent",
                          // The folder arrow turns rather than snaps.
                          "[&>svg:first-child]:transition-transform [&>svg:first-child]:duration-150 [&>svg:first-child]:ease-[cubic-bezier(0.22,1,0.36,1)]",
                          item.getId() === activeId && "bg-foreground/10"
                        )}
                      >
                        <RowHover
                          card={hoverOf(item.getId())}
                          path={item.getId()}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <FileGlyph item={item} />
                            {item.isRenaming() ? (
                              <Input
                                {...item.getRenameInputProps()}
                                autoFocus
                                aria-label={`Rename ${item.getItemName()}`}
                                // The name without its extension, ready to type over.
                                onFocus={(event) => {
                                  const value = event.currentTarget.value
                                  const dot = value.lastIndexOf(".")
                                  event.currentTarget.setSelectionRange(
                                    0,
                                    item.isFolder() || dot <= 0
                                      ? value.length
                                      : dot
                                  )
                                }}
                                onClick={(event) => event.stopPropagation()}
                                className="h-6 px-1.5"
                              />
                            ) : (
                              <span className="truncate">
                                {displayName(item)}
                              </span>
                            )}
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

          <ContextMenuContent
            className="w-52"
            onCloseAutoFocus={openRenameOnClose}
          >
            {menuTarget !== null ? (
              <ContextMenuActions actions={rowActions(menuTarget)} />
            ) : null}
            <ContextMenuActions actions={newActions(menuTarget)} />
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleting === null ? "" : basename(deleting)}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting !== null && snapshot.dirs.includes(deleting)
                ? "It and everything in it leave the vault for everyone it syncs with."
                : "It leaves the vault for everyone it syncs with."}{" "}
              Its history keeps the last version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting !== null && remove(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AskNameDialog
        asking={asking}
        onClose={() => setAsking(null)}
        onMake={(name) =>
          asking === null
            ? Promise.resolve()
            : made(asking.create, asking.parent, name)
        }
      />
    </SidebarGroup>
  )
}

/** A row in a hover card when its claim draws one; the row alone otherwise. */
function RowHover({
  card: Card,
  path,
  children,
}: {
  card: ComponentType<{ path: string }> | undefined
  path: string
  children: ReactElement
}) {
  if (Card === undefined) return children
  return (
    <HoverCard openDelay={500} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-80 p-0">
        <Card path={path} />
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * The name a New menu item asks for before it makes anything (a link's
 * address), in a field that says the item's placeholder. A refusal stays in
 * the dialog, under the field, with what was typed.
 */
function AskNameDialog({
  asking,
  onClose,
  onMake,
}: {
  asking: { create: ClaimCreate; parent: string } | null
  onClose: () => void
  onMake: (name: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    setName("")
    setError(null)
    onClose()
  }
  const label = asking?.create.label ?? ""
  return (
    <Dialog open={asking !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() === "" || busy) return
            setBusy(true)
            setError(null)
            onMake(name.trim())
              .then(close, (err: unknown) =>
                setError(err instanceof Error ? err.message : String(err))
              )
              .finally(() => setBusy(false))
          }}
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {asking?.parent ? `In ${asking.parent}.` : "At the vault’s top."}
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error !== null || undefined}>
            <FieldLabel htmlFor="ask-name" className="sr-only">
              {label}
            </FieldLabel>
            <Input
              id="ask-name"
              autoFocus
              value={name}
              placeholder={asking?.create.placeholder}
              spellCheck={false}
              aria-invalid={error !== null || undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A row's name: the file's name without its extension, which the icon
 *  already says. Folders keep theirs whole. */
function displayName(item: ItemInstance<TreeItemData>): string {
  const name = item.getItemName()
  if (item.isFolder() && !item.getItemData()?.isDocument) return name
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

/** Folders keep their folder glyph; every file, an app bundle included,
 *  shows ReUI's file-type icon for its kind. */
function FileGlyph({ item }: { item: ItemInstance<TreeItemData> }) {
  const data = item.getItemData()
  if (item.isFolder() && !data?.isDocument) {
    return item.isExpanded() ? (
      <FolderOpenIcon
        className="text-muted-foreground size-4"
        aria-hidden="true"
      />
    ) : (
      <FolderIcon className="text-muted-foreground size-4" aria-hidden="true" />
    )
  }
  return (
    <FileType
      type={getFileType(item.getItemName())}
      size="mini"
      aria-hidden="true"
      className="shrink-0"
    />
  )
}
