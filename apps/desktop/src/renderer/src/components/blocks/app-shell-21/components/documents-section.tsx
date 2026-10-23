import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
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
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
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
  vaultsAtom,
} from "@/state/vaults"
import {
  AppWindowIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListChecksIcon,
  PencilIcon,
  PlusIcon,
  SquareKanbanIcon,
} from "lucide-react"
import GradualBlur from "@/components/react-bits/GradualBlur"

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

/** New Document and Board, above the files. */
export function DocumentsNav({
  activeId,
  onNewDocument,
  onOpen,
}: {
  activeId: string | null
  onNewDocument: () => void
  onOpen: (id: string) => void
}) {
  const openTasks = useAtomValue(openTaskCountAtom)

  return (
    <SidebarMenu className="gap-0.5 px-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onNewDocument}
          className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
        >
          <PlusIcon aria-hidden="true" />
          <span>New Document</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={activeId === BOARD_TAB}
          onClick={() => onOpen(BOARD_TAB)}
          className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
        >
          <SquareKanbanIcon aria-hidden="true" />
          <span>Board</span>
          {openTasks > 0 ? (
            <SidebarMenuBadge>{openTasks}</SidebarMenuBadge>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** A new, uniquely named note at the vault's root, for New Document and +. */
export function useNewDocument(onCreated: (path: string) => void) {
  const { taken } = useFiles()
  const createNote = useSetAtom(createNoteAtom)
  return async () => {
    const path = freeName(taken, "", "Untitled", ".md")
    await createNote(path)
    onCreated(path)
  }
}

/**
 * The vault's files as a ReUI tree. Drag a row to reorder it among its
 * siblings (kept per machine, `state/tree-order.ts`) or into another folder
 * (a move that rewrites links); drop files from Finder anywhere on it to copy
 * them in. Right-click for the section's menu.
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
  /** Set by the menu's Rename; the field opens once the menu has closed, so
   *  the menu handing focus back does not take it from the field. */
  const renameNext = useRef<string | null>(null)

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
    if (inside.length > 0 && canMoveInto(inside, dest)) {
      await move(planMoveInto(files.docPaths, inside, dest))
    }
    if (outside.length > 0) {
      const skipped = await importFiles(outside, dest)
      for (const { name, reason } of skipped) toast.error(`${name}: ${reason}`)
    }
  }

  /** A new name in the same folder: a file moves, a folder moves what it
   *  holds. Either way links are rewritten and open tabs follow. */
  async function rename(item: ItemInstance<TreeItemData>, value: string) {
    const from = item.getId()
    const name = value.trim()
    if (name === "" || name === basename(from)) return
    if (name.includes("/")) {
      toast.error("A name can't contain a slash.")
      return
    }
    const to = joinPath(parentOf(from), name)
    if (files.taken.has(to)) {
      toast.error(`There is already a ${name} here.`)
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
      return
    }
    const { moves } = planRenameFolder(files.allPaths, from, name)
    // An empty folder holds only its keep file.
    await move(
      moves.length > 0
        ? moves
        : [{ from: `${from}/${GITKEEP}`, to: `${to}/${GITKEEP}` }]
    )
  }

  async function onDrop(
    items: ItemInstance<TreeItemData>[],
    target: DragTarget<TreeItemData>
  ) {
    const dest = folderOf(target.item)
    const sources = items.map((item) => item.getId())
    const moving = sources.filter((source) => parentOf(source) !== dest)
    if (moving.length > 0) {
      if (!canMoveInto(moving, dest)) return
      await move(planMoveInto(files.docPaths, moving, dest))
    }
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
    onRename: (item, value) => void rename(item, value),
    canReorder: true,
    onDrop: (items, target) => void onDrop(items, target),
    canDropForeignDragObject: (dataTransfer) =>
      dataTransfer.types.includes("Files"),
    onDropForeignDragObject: (dataTransfer, target) =>
      void dropPaths(
        [...dataTransfer.files].map((file) => window.holi.pathForFile(file)),
        folderOf(target.item)
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
    void dropPaths(
      [...event.dataTransfer.files].map((file) =>
        window.holi.pathForFile(file)
      ),
      ""
    )
  }

  async function newNote() {
    const name = freeName(files.taken, "", "Untitled", ".md")
    await createNote(name)
    onOpen(name)
  }

  const empty = (data[ROOT_ID]?.children.length ?? 0) === 0

  return (
    <SidebarGroup className="min-h-0 flex-1 px-2 pb-0">
      <SidebarGroupLabel>Files</SidebarGroupLabel>
      <SidebarGroupAction title="New note" onClick={() => void newNote()}>
        <PlusIcon aria-hidden="true" />
        <span className="sr-only">New note</span>
      </SidebarGroupAction>

      {/* The tree fades into a blur at its foot while there is more below. */}
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
              // Rows fade out over the bottom padding, so the blur above has
              // nothing sharp to stop on at the edge; at the end of the list
              // the last row clears the fade.
              style={{
                maskImage:
                  "linear-gradient(to bottom, #000 calc(100% - 3rem), transparent calc(100% - 1rem))",
              }}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-auto pb-12 overscroll-contain rounded-md",
                "data-dropping:bg-foreground/5 data-dropping:ring-ring/50 data-dropping:ring-1"
              )}
            >
              {empty ? (
                <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                  Drop files here, or right-click to add one.
                </p>
              ) : (
                <Tree indent={INDENT} tree={tree} className="relative">
                  {tree.getItems().map((item) => (
                    <TreeItem
                      key={item.getId()}
                      item={item}
                      onContextMenu={() => setMenuTarget(item.getId())}
                    >
                      <TreeItemLabel
                        className={cn(
                          "hover:bg-foreground/5 bg-transparent",
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
            onCloseAutoFocus={(event) => {
              const id = renameNext.current
              if (id === null) return
              renameNext.current = null
              event.preventDefault()
              tree.getItemInstance(id).startRenaming()
            }}
          >
            {menuTarget !== null ? (
              <>
                <ContextMenuItem
                  onSelect={() => {
                    renameNext.current = menuTarget
                  }}
                >
                  <PencilIcon aria-hidden="true" />
                  Rename
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            <ContextMenuItem
              onSelect={() =>
                void createFolder(freeName(files.taken, "", "New folder"))
              }
            >
              <FolderPlusIcon aria-hidden="true" />
              New folder
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={async () => {
                const path = await createTask({
                  title: "Untitled task",
                  status: "todo",
                  folder: "",
                })
                if (path) onOpen(path)
              }}
            >
              <ListChecksIcon aria-hidden="true" />
              New task
            </ContextMenuItem>
            {creates.map((create) => (
              <ContextMenuItem
                key={create.id}
                disabled={files.remote === null}
                onSelect={async () => {
                  if (files.remote === null) return
                  const path = await create.run({
                    remote: files.remote,
                    parent: "",
                    name: freeName(files.taken, "", "Untitled", ".app").replace(
                      /\.app$/,
                      ""
                    ),
                  })
                  if (path) onOpen(path)
                }}
              >
                <AppWindowIcon aria-hidden="true" />
                {create.label}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuCheckboxItem
              checked={files.showTasks}
              onCheckedChange={files.toggleTasks}
            >
              Show task files
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              checked={files.showHidden}
              onCheckedChange={files.toggleHidden}
            >
              Show hidden files
            </ContextMenuCheckboxItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => tree.collapseAll()}>
              Collapse all
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <GradualBlur
          position="bottom"
          height="3rem"
          strength={2}
          layers={8}
          curve="linear"
          exponential
          autoHide
          zIndex={10}
          edgeFade={0.3}
        />
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
