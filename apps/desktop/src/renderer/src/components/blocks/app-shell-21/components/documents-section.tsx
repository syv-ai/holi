import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
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
import { GITKEEP, isHiddenPath, TASKS_CLAIM } from "@holi/shared"
import { cn } from "@/lib/cn"

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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import {
  Tree,
  TreeDragLine,
  TreeItem,
  TreeItemLabel,
} from "@/components/reui/tree"
import { folderDocumentAt } from "@/lib/folder-documents"
import { buildTreeData, ROOT_ID, type TreeItemData } from "@/lib/tree-data"
import { planMoveInto, planRenameFolder, type Move } from "@/lib/tree-actions"
import { basename, joinPath, parentOf } from "@/lib/tree-paths"
import { canMoveInto } from "@/lib/tree-view"
import { claimsAtom, folderClaimsAtom } from "@/state/plugins"
import { createTaskAtom, openTaskCountAtom } from "@/state/tasks"
import { setTreeOrderAtom, treeOrderAtom } from "@/state/tree-order"
import {
  activeRemoteAtom,
  createFolderAtom,
  createNoteAtom,
  importFilesAtom,
  moveNotesAtom,
  showHiddenByVaultAtom,
  showTasksByVaultAtom,
  snapshotAtom,
  snapshotLoadedAtom,
  vaultsAtom,
} from "@/state/vaults"
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  FolderInputIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListChecksIcon,
  SearchIcon,
  PencilIcon,
  PlusIcon,
  SquareKanbanIcon,
} from "lucide-react"

/** The header tab id of the task board, beside the document paths. */
export const BOARD_TAB = "board"

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
  const paths = showHidden
    ? docPaths
    : docPaths.filter((path) => !isHiddenPath(path))
  const dirs = showHidden
    ? snapshot.dirs
    : snapshot.dirs.filter((dir) => !isHiddenPath(dir))

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

/** The reveal curve for things that arrive (ReUI's motion rules). */
const ARRIVE =
  "animate-in fade-in-0 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"

/** Search and Board, at the top of the Documents tab. */
export function DocumentsNav({
  activeId,
  onOpenSearch,
  onOpen,
}: {
  activeId: string | null
  onOpenSearch: () => void
  onOpen: (id: string) => void
}) {
  const openTasks = useAtomValue(openTaskCountAtom)

  return (
    <SidebarMenu className="gap-0.5 px-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onOpenSearch}
          className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
        >
          <SearchIcon aria-hidden="true" />
          <span>Search</span>
          <Kbd className="ms-auto">⌘K</Kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={activeId === BOARD_TAB}
          aria-current={activeId === BOARD_TAB ? "page" : undefined}
          onClick={() => onOpen(BOARD_TAB)}
          className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
        >
          <SquareKanbanIcon aria-hidden="true" />
          <span>Board</span>
          {openTasks > 0 ? (
            <span className="sr-only">, {openTasks} open tasks</span>
          ) : null}
        </SidebarMenuButton>
        {/* A sibling of the button, where the badge's own placement applies;
            keyed on the count, so a change pops it in again. */}
        {openTasks > 0 ? (
          <SidebarMenuBadge
            key={openTasks}
            aria-hidden="true"
            className={cn(ARRIVE, "zoom-in-95 motion-reduce:zoom-in-100")}
          >
            {openTasks}
          </SidebarMenuBadge>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** New document, heading the files it adds to. */
export function NewDocumentNav({
  onNewDocument,
}: {
  onNewDocument: () => void
}) {
  return (
    <SidebarMenu className="px-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onNewDocument}
          className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
        >
          <PlusIcon aria-hidden="true" />
          <span>New document</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
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
  const creates = useAtomValue(claimsAtom).flatMap(
    (claim) => claim.create ?? []
  )
  const vaults = useAtomValue(vaultsAtom)
  const createNote = useSetAtom(createNoteAtom)
  const createFolder = useSetAtom(createFolderAtom)
  const createTask = useSetAtom(createTaskAtom)
  const moveNotes = useSetAtom(moveNotesAtom)
  const importFiles = useSetAtom(importFilesAtom)
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
      dataTransfer.types.includes("Files"),
    onDropForeignDragObject: (dataTransfer, target) =>
      void attempt("add the files", () =>
        dropPaths(
          [...dataTransfer.files].map((file) => window.holi.pathForFile(file)),
          folderOf(target.item)
        )
      ),
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

  /** Finder drops on the empty space below the rows land at the root. */
  function onAreaDrop(event: DragEvent) {
    setDropping(false)
    if (event.defaultPrevented || event.dataTransfer.files.length === 0) return
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
    return [
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
      { kind: "separator" },
    ]
  }

  const sectionActions: MenuAction[] = [
    {
      kind: "item",
      label: "New folder",
      icon: <FolderPlusIcon aria-hidden="true" />,
      run: () =>
        void attempt("create the folder", async () => {
          const name = freeName(files.taken, "", "New folder")
          await createFolder(name)
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
            folder: "",
          })
          if (path) onOpen(path)
        }),
    },
    ...creates.map((create): MenuAction => ({
      kind: "item",
      label: create.label,
      icon: <AppWindowIcon aria-hidden="true" />,
      disabled: files.remote === null,
      run: () =>
        void attempt("create the app", async () => {
          if (files.remote === null) return
          const path = await create.run({
            remote: files.remote,
            parent: "",
            name: freeName(files.taken, "", "Untitled", ".app").replace(
              /\.app$/,
              ""
            ),
          })
          if (path) {
            markArrived([path])
            onOpen(path)
          }
        }),
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
          <DropdownMenuActions actions={sectionActions} />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The rows fade out at the tree's foot (the mask below). */}
      <div className="relative flex min-h-24 flex-1 flex-col">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              data-dropping={dropping || undefined}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return
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
                              {item.getItemName()}
                            </span>
                          )}
                        </span>
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
            <ContextMenuActions actions={sectionActions} />
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </SidebarGroup>
  )
}

function FileGlyph({ item }: { item: ItemInstance<TreeItemData> }) {
  const data = item.getItemData()
  if (data?.isDocument) {
    return (
      <AppWindowIcon
        className="text-muted-foreground size-4"
        aria-hidden="true"
      />
    )
  }
  if (item.isFolder()) {
    return item.isExpanded() ? (
      <FolderOpenIcon
        className="text-muted-foreground size-4"
        aria-hidden="true"
      />
    ) : (
      <FolderIcon className="text-muted-foreground size-4" aria-hidden="true" />
    )
  }
  return item.getId().endsWith(".md") ? (
    <FileTextIcon className="text-muted-foreground size-4" aria-hidden="true" />
  ) : (
    <FileIcon className="text-muted-foreground size-4" aria-hidden="true" />
  )
}
