import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { syncDataLoaderFeature, type ItemInstance } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { DeleteConfirm } from '@/composites'
import { fileIconFor, pathGlyph, pathLabel } from '@/composites/file-icons'
import { cn } from '@/lib/cn'
import { FOLDER_GLYPH } from '@/lib/folder-colour'
import { folderDocumentAt, surfaceLabel } from '@/lib/folder-documents'
import {
  canMoveInto,
  dropFolder,
  newItemPlace,
  rangeBetween,
  typeahead,
  visibleRows,
} from '@/lib/tree-view'
import { buildTreeData, ROOT_ID, type TreeItemData } from '@/lib/tree-data'
import { placeAmong } from '@/lib/tree-order'
import { folderColoursAtom } from '@/state/folder-colours'
import { setTreeOrderAtom, treeOrderAtom } from '@/state/tree-order'
import {
  ancestorsOf,
  joinPath,
  parentOf,
  renameBasenameRange,
  withMdExtension,
} from '@/lib/tree-paths'
import {
  Button,
  ContextMenu,
  ContextMenuTrigger,
  Icon,
  Input,
  Tooltip,
  Tree,
  TreeDragLine,
  TreeItem,
  TreeItemLabel,
} from '@/primitives'
import { todayDailyPathAtom } from '@/state/daily'
import { useAgentService } from '@/state/agent-service'
import { claimsAtom, folderClaimsAtom, surfacesAtom } from '@/state/plugins'
import { revealRequestAtom } from '@/state/reveal'
import { createTaskAtom, todayLinkCountAtom } from '@/state/tasks'
import {
  activeRemoteAtom,
  createFolderAtom,
  createNoteAtom,
  importFilesAtom,
  loadSnapshotAtom,
  renameNoteAtom,
  vaultsAtom,
} from '@/state/vaults'
import { ExplorerHeader, type NewKind } from './ExplorerHeader'
import { RowMenu } from './RowMenu'
import { useExplorerActions } from './useExplorerActions'
import { useTreeProjection } from './useTreeProjection'

/**
 * The explorer (docs/features/file-tree.md), drawn with the app's one tree
 * (`primitives/Tree.tsx`, ReUI's): a chevron, an icon and a name per row, a
 * flat indent per level, and nothing that moves but the hover colour. A
 * `@headless-tree` instance flattens and indents what `open` shows and gives
 * the rows their tree semantics; clicks, keys, drag and drop and the menus are
 * this file's own.
 *
 * A folder document (a claim's `folder`, such as an app bundle) is a folder
 * that behaves as a file: a click opens it, and its files show only when it
 * is expanded: by →, by Show App Files, or by the chevron at the row's right
 * end that hover or focus reveals. A draft one (an unfinished app) has
 * nothing to open yet, so a click shows its files.
 *
 * A view of the snapshot that owns no vault data. Its rules (which rows show,
 * ranges, typeahead, where a drop may go) are in `lib/tree-view.ts`; this is
 * state, DOM and wiring.
 */

/** `single` keeps one path open, as the reference does; `multi` lets folders stay open. */
export type TreeExpansion = 'single' | 'multi'

/** How long a drag hovers on a closed folder before it opens. */
const SPRING_OPEN_MS = 600
/** How long typed letters keep adding to one typeahead query. */
const TYPEAHEAD_MS = 700
/** Each level's indent: the chevron and its gap, so a child's chevron sits
 *  under its parent's icon. */
const TREE_INDENT = 20
/** What the data loader answers for an id the data no longer has. */
const MISSING: TreeItemData = { name: '', isFolder: false, isDocument: false, children: [] }

/** The new item's field says what it is naming. */
const PLACEHOLDERS: Record<'task' | 'file' | 'folder', string> = {
  task: 'task title',
  file: 'note name',
  folder: 'folder name',
}

const placeholderOf = (kind: NewKind): string =>
  typeof kind === 'string' ? PLACEHOLDERS[kind] : kind.placeholder

/**
 * The inline name field, for a rename and for a new file, folder, task or app. Enter
 * commits, Escape and blur cancel, as FileTree's do. A rename preselects the
 * name without its extension.
 */
function NameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string
  placeholder?: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  // Focused a frame after mounting, not by `autoFocus`: opened from the row
  // menu, the field mounts while the menu still holds the focus.
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <Input
      ref={ref}
      className="h-6 min-w-0 flex-1 rounded-md px-1.5 py-0 text-nav"
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => {
        const el = e.currentTarget
        const [start, end] = renameBasenameRange(el.value)
        setTimeout(() => el.setSelectionRange(start, end), 0)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
        if (e.key === 'Enter' && value.trim()) onCommit(value.trim())
      }}
      onBlur={onCancel}
    />
  )
}

export function FileTree({
  activePath,
  onOpenPreview,
  onOpenPinned,
  onOpenInNewPane,
  expansion = 'single',
  sectionLabel,
}: {
  /** A section name at the start of the toolbar's band ("Files"). */
  sectionLabel?: string
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
  onOpenInNewPane: (path: string) => void
  expansion?: TreeExpansion
}) {
  const projection = useTreeProjection()
  const { visible, taskByPath, iconByPath, ignored } = projection
  const actions = useExplorerActions(projection.docPaths)
  const folderClaims = useAtomValue(folderClaimsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  /** What enabled claims add to the New menu (an app, which the agent
   *  writes, so only while there is one). */
  const claims = useAtomValue(claimsAtom)
  const agent = useAgentService()
  const creates = useMemo(
    () =>
      claims.flatMap((c) =>
        c.create && (c.create.agent !== true || agent !== null) ? [c.create] : [],
      ),
    [claims, agent],
  )
  const present = useMemo(() => new Set(projection.docPaths), [projection.docPaths])
  /** The folder at `id` as a document (an app), or null. */
  const documentAt = (id: string) => folderDocumentAt(folderClaims, id, (p) => present.has(p))
  /** A document with nothing to open yet (an unfinished app). */
  const isDraft = (id: string) => documentAt(id)?.ready === false
  /** What a document is called as a kind ("App"), from its surface. */
  const nounOf = (id: string) => {
    const surface = surfaces.get(documentAt(id)?.folder.surface ?? '')
    return surface === undefined ? 'Document' : surfaceLabel(surface)
  }
  const treeOrder = useAtomValue(treeOrderAtom)
  const setTreeOrder = useSetAtom(setTreeOrderAtom)
  const data = useMemo(
    () =>
      buildTreeData(
        visible.paths,
        [...visible.dirs, ...actions.pendingFolders],
        (dir, has) => folderDocumentAt(folderClaims, dir, has) !== null,
        treeOrder,
      ),
    [visible, actions.pendingFolders, folderClaims, treeOrder],
  )
  const renameNote = useSetAtom(renameNoteAtom)
  const createNote = useSetAtom(createNoteAtom)
  const createFolder = useSetAtom(createFolderAtom)
  const createTask = useSetAtom(createTaskAtom)
  const loadSnapshot = useSetAtom(loadSnapshotAtom)
  const importFiles = useSetAtom(importFilesAtom)
  const revealRequest = useAtomValue(revealRequestAtom)
  const todayDailyPath = useAtomValue(todayDailyPathAtom)
  const todayLinkCount = useAtomValue(todayLinkCountAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vault = useAtomValue(vaultsAtom).find((v) => v.remote === activeRemote)
  const vaultPrefix = vault ? `${vault.path}/` : null

  const [open, setOpen] = useState<Set<string>>(() => new Set())
  /** The selection, and the row a ⇧ range runs from. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  /** The row that takes Tab: one focusable row, moved by the arrow keys. */
  const [focusId, setFocusId] = useState<string | null>(null)
  /** The row whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** A new item being named, the folder it lands in ('' = root), and the row
   *  its field shows under (`null`: first in the folder). */
  const [pending, setPending] = useState<{
    kind: NewKind
    parent: string
    after: string | null
  } | null>(null)
  /** The folder a drag from the OS would land in ('' = root), while one is over the tree. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** Where a drop beside a row would land: the row, and above or below it. */
  const [dropLine, setDropLine] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  /** Files the last drop refused, held until dismissed or superseded: a file that
   *  silently did not arrive is the worst outcome of an import. */
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([])

  const rows = useMemo(() => visibleRows(data, open), [data, open])
  const colours = useAtomValue(folderColoursAtom)
  /** How many files each folder holds, at any depth, of those the tree shows:
   *  a folder's size at a glance, beside its name. */
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    const walk = (id: string): number => {
      const node = data[id]
      if (node === undefined) return 0
      if (!node.isFolder || node.isDocument) return 1
      const n = node.children.reduce((sum, child) => sum + walk(child), 0)
      out.set(id, n)
      return n
    }
    walk(ROOT_ID)
    return out
  }, [data])
  // A new array as the data changes too, which is what makes the tree flatten again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const expandedItems = useMemo(() => [...open], [open, data])

  const navRef = useRef<HTMLDivElement>(null)
  const rowEl = (id: string) =>
    navRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(id)}"]`) ?? null

  const openBranch = (path: string, andSelf: boolean) => {
    const chain = [...ancestorsOf(path), ...(andSelf ? [path] : [])]
    setOpen((prev) => (expansion === 'single' ? new Set(chain) : new Set([...prev, ...chain])))
  }

  // Opening a file (from anywhere: a tab, a link, the palette) opens its
  // branch; but only a file the tree shows. A task opened from the board while
  // tasks are hidden has no row to go to, and following it would open folders
  // around nothing. Showing tasks then follows it.
  const activeShown = activePath !== null && data[activePath] !== undefined
  useEffect(() => {
    if (activePath === null || !activeShown) return
    openBranch(activePath, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, activeShown, expansion])

  const toggle = (id: string) => {
    if (!open.has(id)) return openBranch(id, true)
    setOpen((prev) => new Set([...prev].filter((p) => p !== id && !p.startsWith(`${id}/`))))
  }

  const select = (ids: string[], from: string) => {
    setSelected(new Set(ids))
    setAnchor(from)
  }

  /** Move keyboard focus to a row, once it is rendered. */
  const focusRow = (id: string) => {
    setFocusId(id)
    requestAnimationFrame(() => rowEl(id)?.focus())
  }

  /** What an action on `id` applies to: the selection when `id` is in it, else `id`. */
  const targets = (id: string) => (selected.has(id) && selected.size > 1 ? [...selected] : [id])

  // "Show me this file": open to it, select it, bring it into view. Keyed on
  // the nonce, so revealing the same path twice fires twice. Dropped while a
  // name is being typed, which owns the focus.
  const revealed = useRef<number | null>(null)
  const scrollTo = useRef<string | null>(null)
  useEffect(() => {
    if (revealRequest === null || revealed.current === revealRequest.nonce) return
    revealed.current = revealRequest.nonce
    if (renaming !== null || pending !== null) return
    const { path } = revealRequest
    openBranch(path, false)
    select([path], path)
    setFocusId(path)
    scrollTo.current = path
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest])
  // Finishes on the render where the row exists.
  useEffect(() => {
    const el = scrollTo.current === null ? null : rowEl(scrollTo.current)
    if (!el) return
    scrollTo.current = null
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
  })

  const rename = (from: string, node: TreeItemData, name: string) => {
    setRenaming(null)
    // A folder document is named without its suffix, as a note is without its
    // `.md`, and keeps it: an app its `.app`, a personal one its `.local.app`.
    if (node.isDocument) {
      const suffix = documentAt(from)?.claim.decorate?.suffix(from) ?? ''
      return actions.renameFolder(from, `${name}${suffix}`)
    }
    if (node.isFolder) return actions.renameFolder(from, name)
    const to = joinPath(parentOf(from), withMdExtension(name))
    if (to !== from) void renameNote({ from, to })
  }

  /** Open the name input inside `parent`, which opens so the input shows:
   *  first, or right under the row `after`. */
  const startNew = (kind: NewKind, parent: string, after: string | null = null) => {
    if (parent !== '') openBranch(parent, true)
    setPending({ kind, parent, after })
  }

  const create = (name: string) => {
    if (pending === null) return
    const { kind, parent } = pending
    setPending(null)
    switch (kind) {
      case 'folder': {
        // Shown at once, and made real with a `.gitkeep` so it persists.
        const folder = joinPath(parent, name)
        actions.addPendingFolder(folder)
        void createFolder(folder)
        return
      }
      case 'file': {
        const path = joinPath(parent, withMdExtension(name))
        void createNote(path).then(() => onOpenPreview(path))
        return
      }
      case 'task':
        // The name is the title; main names the file. It opens to be filled
        // in, as ⌘⇧T's does, whether or not the tree shows task files.
        void createTask({ title: name, status: 'todo', folder: parent }).then(
          (path) => path !== null && onOpenPinned(path),
        )
        return
      default: {
        // A claim's own kind (an app). It opens what it made, once the
        // snapshot holds it.
        if (activeRemote === null) return
        void kind.run({ remote: activeRemote, parent, name, agent }).then(async (path) => {
          await loadSnapshot()
          if (path !== null) onOpenPreview(path)
        })
      }
    }
  }

  /**
   * ⌘⇧ adds or removes one row, ⇧ selects a range, ⌘ opens a file in a new
   * pane; a plain click selects the row and opens it (a folder toggles).
   */
  const onRowClick = (e: MouseEvent, id: string, node: TreeItemData) => {
    setFocusId(id)
    if (e.metaKey && e.shiftKey) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
      setAnchor(id)
      return
    }
    if (e.shiftKey && anchor !== null) return setSelected(new Set(rangeBetween(rows, anchor, id)))
    select([id], id)
    // A draft document has nothing to open yet, so it shows its files instead.
    if (node.isFolder && (!node.isDocument || isDraft(id))) toggle(id)
    else if (e.metaKey) onOpenInNewPane(id)
    else onOpenPreview(id)
  }

  const typed = useRef({ query: '', at: 0 })

  /** A key on a focused row. Returns whether it acted, so the caller can claim it. */
  const rowKey = (e: KeyboardEvent, id: string, node: TreeItemData): boolean => {
    const { isFolder, isDocument } = node
    const mod = e.metaKey || e.ctrlKey
    const i = rows.findIndex((r) => r.id === id)
    const next = rows[i + 1]
    /** Arrow-key movement: ⇧ extends the selection from the anchor, else it follows. */
    const moveTo = (to: string | undefined) => {
      if (to === undefined) return
      if (e.shiftKey) setSelected(new Set(rangeBetween(rows, anchor ?? id, to)))
      else select([to], to)
      focusRow(to)
    }

    // Typeahead: letters typed in quick succession jump to the row they begin.
    // A space only counts inside a query, so on its own it still clicks.
    if (e.key.length === 1 && !mod && !e.altKey && (e.key !== ' ' || typed.current.query)) {
      const now = Date.now()
      const query = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.query : '') + e.key
      typed.current = { query, at: now }
      const to = typeahead(rows, id, query, (r) => label(r, data[r]!))
      if (to && to !== id) {
        select([to], to)
        focusRow(to)
      }
      return true
    }

    if (mod) {
      if (e.code === 'KeyA')
        select(
          rows.map((r) => r.id),
          id,
        )
      else if (e.code === 'KeyX') actions.cut(targets(id))
      else if (e.code === 'KeyC') actions.copy(targets(id))
      else if (e.code === 'KeyV') actions.paste(isFolder && !isDocument ? id : parentOf(id))
      else if (e.code === 'KeyD') actions.duplicate(targets(id))
      else return false
      return true
    }

    switch (e.key) {
      case 'ArrowDown':
        moveTo(next?.id)
        break
      case 'ArrowUp':
        moveTo(rows[i - 1]?.id)
        break
      case 'Home':
        moveTo(rows[0]?.id)
        break
      case 'End':
        moveTo(rows[rows.length - 1]?.id)
        break
      case 'ArrowRight':
        // Opens a folder, then steps into it. A document's contents open the same way.
        if (isFolder && !open.has(id)) toggle(id)
        else if (isFolder && next && parentOf(next.id) === id) moveTo(next.id)
        break
      case 'ArrowLeft':
        // Closes a folder, then steps out to the parent.
        if (isFolder && open.has(id)) toggle(id)
        else moveTo(parentOf(id) || undefined)
        break
      case 'Enter':
        if (isFolder && (!isDocument || isDraft(id))) toggle(id)
        else onOpenPreview(id)
        break
      case 'Escape':
        select([id], id)
        break
      case 'F2':
        setRenaming(id)
        break
      case 'Delete':
      case 'Backspace':
        actions.startDelete(targets(id), isFolder)
        break
      default:
        return false
    }
    return true
  }

  // ── Drag and drop ──────────────────────────────────────────────────────
  // One mechanism. A row's drag is a native OS drag of the target files, so it
  // can leave the app; anything dropped on the tree arrives as files. A source
  // inside this vault is a move (links rewritten, tabs follow), anything else
  // is an import. The middle of a closed folder drops into it; a row's top or
  // bottom edge drops beside it, at that place in its folder, which the tree
  // then keeps as its order (`lib/tree-order.ts`), on this machine.
  const springOpen = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const endDrag = () => {
    if (springOpen.current) clearTimeout(springOpen.current.timer)
    springOpen.current = null
    setDropTarget(null)
    setDropLine(null)
  }
  /** The row under a drag event, if any, the folder a drop there lands in,
   *  and whether it lands beside the row (`line`) rather than in a folder. */
  const dropAt = (e: DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    const id = row?.getAttribute('data-path') ?? null
    // A drop on a document lands beside it, as on a file, not among its files.
    const isFolder = id !== null && data[id]?.isFolder === true && !data[id]?.isDocument
    let line: { id: string; side: 'before' | 'after' } | null = null
    if (row != null && id !== null) {
      const box = row.getBoundingClientRect()
      const y = box.height > 0 ? (e.clientY - box.top) / box.height : 0.5
      // A closed folder keeps its middle for "into"; an open one gives its
      // lower part to "into" too, since what shows under it is its contents.
      if (!isFolder) line = { id, side: y < 0.5 ? 'before' : 'after' }
      else if (y < 0.28) line = { id, side: 'before' }
      else if (y > 0.72 && !open.has(id)) line = { id, side: 'after' }
    }
    const dest = line !== null ? parentOf(line.id) : dropFolder(id, isFolder)
    return { id, isFolder, dest, line }
  }
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { id, isFolder, dest, line } = dropAt(e)
    setDropLine(line)
    setDropTarget(line === null ? dest : null)
    // Hovering a closed folder opens it, as Finder does.
    if (springOpen.current?.id === id) return
    if (springOpen.current) clearTimeout(springOpen.current.timer)
    springOpen.current =
      id !== null && isFolder && !open.has(id)
        ? { id, timer: setTimeout(() => openBranch(id, true), SPRING_OPEN_MS) }
        : null
  }
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    const { dest, line } = dropAt(e)
    endDrag()
    const sources = [...e.dataTransfer.files].map((f) => window.holi.pathForFile(f))
    const mine = vaultPrefix ? sources.filter((p) => p.startsWith(vaultPrefix)) : []
    const theirs = sources.filter((p) => !mine.includes(p))
    const moving = mine.map((p) => p.slice(vaultPrefix!.length))
    // Those not in the destination yet move there; then, beside a row, every
    // moved path takes its place in the destination's order.
    const arriving = moving.filter((p) => parentOf(p) !== dest)
    if (arriving.length > 0 && canMoveInto(arriving, dest)) actions.moveInto(arriving, dest)
    if (
      line !== null &&
      moving.length > 0 &&
      (arriving.length === 0 || canMoveInto(arriving, dest))
    ) {
      const here = moving.map((p) =>
        parentOf(p) === dest
          ? p
          : `${dest === '' ? '' : `${dest}/`}${p.slice(p.lastIndexOf('/') + 1)}`,
      )
      const siblings = data[dest === '' ? ROOT_ID : dest]?.children ?? []
      setTreeOrder(dest, placeAmong(siblings, here, line.id, line.side))
    }
    if (theirs.length > 0) void importFiles(theirs, dest).then(setSkipped)
  }

  /**
   * A note is named without its `.md`; everything else keeps its extension.
   * The rule is `pathLabel`, which the tabs share.
   */
  const label = (id: string, node: TreeItemData) =>
    node.isDocument
      ? (documentAt(id)?.claim.decorate?.name(id) ?? node.name)
      : node.isFolder
        ? node.name
        : pathLabel(id)

  /**
   * The row's icon, after the folder's chevron (or a file's empty chevron
   * column, so every icon lines up): the vault icon map's emoji first, a
   * document's own glyph (an app's), a folder's folder, a task's status, and
   * otherwise the file's type glyph, a note's included.
   */
  const rowIcon = (id: string, node: TreeItemData, isOpen: boolean) => {
    const emoji = iconByPath.get(id)
    let glyph: ReactNode
    if (node.isDocument) {
      const icon = documentAt(id)?.claim.decorate?.icon
      glyph = emoji || icon === undefined ? fileIconFor(id, emoji) : <Icon icon={icon} size="sm" />
    } else if (node.isFolder) {
      glyph = emoji ? (
        fileIconFor(id, emoji)
      ) : (
        <Icon
          icon={isOpen ? FolderOpen : Folder}
          size="sm"
          tone={colours[id] === undefined ? 'muted' : undefined}
          className={colours[id] === undefined ? undefined : FOLDER_GLYPH[colours[id]]}
        />
      )
    } else {
      glyph = pathGlyph(id, { emoji, task: taskByPath.get(id)?.status }) ?? fileIconFor(id)
    }
    return (
      <span
        data-slot="row-icon"
        className={cn('flex w-3.5 shrink-0 justify-center', ignored.has(id) && 'opacity-50')}
      >
        {glyph}
      </span>
    )
  }

  /**
   * A folder document's chevron: its files are behind it, and this is the way
   * in that a newcomer can see, shown on hover or focus and while they are
   * open. Not a button: it sits in the row's, and the keyboard's way is → as
   * for any folder.
   */
  const documentToggle = (id: string, isOpen: boolean) => (chevron: ReactNode) => (
    <Tooltip content={`${isOpen ? 'Hide' : 'Show'} ${nounOf(id).toLowerCase()} files`}>
      <span
        aria-hidden="true"
        data-slot="document-files"
        onClick={(e) => {
          e.stopPropagation()
          toggle(id)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn(
          'motion-respond flex shrink-0',
          !isOpen && 'opacity-0 group-hover/doc:opacity-100 group-focus-visible/doc:opacity-100',
        )}
      >
        {chevron}
      </span>
    </Tooltip>
  )

  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    indent: TREE_INDENT,
    getItemName: (item) => label(item.getId(), item.getItemData()),
    isItemFolder: (item) => item.getItemData().isFolder,
    dataLoader: {
      getItem: (id) => data[id] ?? MISSING,
      getChildren: (id) => data[id]?.children ?? [],
    },
    // Ours, controlled: the tree flattens and indents what `open` shows. Its
    // own clicks are overridden, so nothing asks it to change these.
    state: { expandedItems, focusedItem: focusId },
    setExpandedItems: () => {},
    setFocusedItem: () => {},
    features: [syncDataLoaderFeature],
  })
  const items = tree.getItems()

  /**
   * A row: a tree item under the row menu, or, while it is being renamed, the
   * same row holding the name field (a field cannot sit inside a button).
   * A selection shows only once it is more than one row: a single one is
   * already said by the open file's weight and the focus ring. A gitignored
   * row dims its name and icon, not itself, so a selection behind it stays solid.
   */
  const row = (item: ItemInstance<TreeItemData>) => {
    const id = item.getId()
    const node = item.getItemData()
    const isOpen = node.isFolder && open.has(id)
    const isCut = actions.clipboard?.mode === 'cut' && actions.clipboard.paths.includes(id)
    if (renaming === id)
      return (
        <TreeItem key={id} item={item} asChild onClick={undefined}>
          <div data-path={id}>
            <TreeItemLabel className="py-0.5">
              {rowIcon(id, node, isOpen)}
              <NameInput
                // As listed: a note without its `.md`, which the rename adds back.
                initial={label(id, node)}
                onCommit={(name) => rename(id, node, name)}
                onCancel={() => setRenaming(null)}
              />
            </TreeItemLabel>
          </div>
        </TreeItem>
      )
    return (
      <ContextMenu key={id}>
        <ContextMenuTrigger asChild>
          <TreeItem
            item={item}
            data-path={id}
            aria-selected={selected.has(id)}
            aria-expanded={node.isFolder ? isOpen : undefined}
            data-selected={selected.size > 1 && selected.has(id)}
            data-drag-target={dropTarget === id}
            tabIndex={id === (focusId ?? rows[0]?.id) ? 0 : -1}
            draggable
            onDragStart={(e) => {
              e.preventDefault()
              if (vaultPrefix) window.holi.startDrag(targets(id).map((p) => vaultPrefix + p))
            }}
            onClick={(e) => onRowClick(e, id, node)}
            onDoubleClick={() => (!node.isFolder || node.isDocument) && onOpenPinned(id)}
            onKeyDown={(e) => {
              if (rowKey(e, id, node)) e.preventDefault()
            }}
            className={cn(
              'w-full',
              node.isDocument && 'group/doc',
              isCut && 'opacity-40',
              dropLine?.id === id && 'relative',
            )}
          >
            {dropLine?.id === id && (
              // The place a drop beside this row lands: a line on its edge.
              <TreeDragLine
                aria-hidden
                data-testid="tree-drop-line"
                className="pointer-events-none"
                style={{
                  insetInlineStart: 'var(--tree-padding)',
                  insetInlineEnd: 0,
                  ...(dropLine.side === 'before' ? { top: 0 } : { bottom: 0 }),
                }}
              />
            )}
            <TreeItemLabel
              className={cn('min-w-0', id === activePath && 'font-semibold')}
              renderToggle={node.isDocument ? documentToggle(id, isOpen) : undefined}
            >
              {rowIcon(id, node, isOpen)}
              <span
                data-slot="row-name"
                className={cn(
                  'min-w-0 truncate',
                  taskByPath.get(id)?.status === 'done' && 'line-through',
                  (ignored.has(id) || (node.isDocument && isDraft(id))) && 'opacity-50',
                )}
              >
                {label(id, node)}
              </span>
              {node.isFolder && !node.isDocument && (counts.get(id) ?? 0) > 0 && (
                <span className="ms-auto shrink-0 ps-2 text-xs font-normal text-muted-foreground tabular-nums">
                  {counts.get(id)}
                </span>
              )}
              {/* Today's daily, marked where it lives (docs/features/daily-notes.md),
                  at the row's right end. */}
              {id === todayDailyPath && (
                <span className="ml-auto shrink-0 text-xs tabular-nums text-brand">
                  today{todayLinkCount > 0 && ` · ${todayLinkCount}`}
                </span>
              )}
            </TreeItemLabel>
          </TreeItem>
        </ContextMenuTrigger>
        <RowMenu
          path={id}
          isFolder={node.isFolder}
          document={
            node.isDocument ? { open: isOpen, ready: !isDraft(id), noun: nounOf(id) } : null
          }
          onToggleContents={() => toggle(id)}
          targets={targets(id)}
          actions={actions}
          onOpenInNewPane={onOpenInNewPane}
          onOpenPinned={onOpenPinned}
          onNew={startNew}
          onRename={() => setRenaming(id)}
        />
      </ContextMenu>
    )
  }

  /** Where the new item's field goes among the rows, and at what level: first
   *  in its folder, or after the row `after` and everything open under it. */
  const pendingAt = (): { index: number; level: number } | null => {
    if (pending === null) return null
    const { parent, after } = pending
    const at = (id: string) => items.findIndex((it) => it.getId() === id)
    if (after === null) {
      if (parent === '') return { index: 0, level: 0 }
      const i = at(parent)
      return i < 0 ? null : { index: i + 1, level: items[i]!.getItemMeta().level + 1 }
    }
    const i = at(after)
    if (i < 0) return null
    const level = items[i]!.getItemMeta().level
    let j = i + 1
    while (j < items.length && items[j]!.getItemMeta().level > level) j++
    return { index: j, level }
  }

  /** The name field for a new item, as a row at its place: a folder's chevron
   *  and glyph, else the empty chevron column, so the name lines up. */
  const pendingRow = (level: number) =>
    pending && (
      <div key="__pending__" className="pb-0.5" style={{ paddingInlineStart: level * TREE_INDENT }}>
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 text-nav',
            pending.kind !== 'folder' && 'ps-7',
          )}
        >
          {pending.kind === 'folder' && (
            <Icon icon={ChevronDown} tone="muted" className="-rotate-90" />
          )}
          <span className="flex w-3.5 shrink-0 justify-center">
            {pending.kind === 'folder' && <Icon icon={Folder} size="sm" tone="muted" />}
          </span>
          <NameInput
            initial=""
            placeholder={placeholderOf(pending.kind)}
            onCommit={create}
            onCancel={() => setPending(null)}
          />
        </div>
      </div>
    )

  const field = pendingAt()
  const listed: ReactNode[] = items.map(row)
  if (field !== null) listed.splice(field.index, 0, pendingRow(field.level))

  /** Everything the last import or export refused, in one list. */
  const refused = [...skipped, ...actions.exportFailures]

  return (
    <div className="group/explorer relative flex min-h-0 flex-1 flex-col">
      <ExplorerHeader
        label={sectionLabel}
        creates={creates}
        onNew={(kind) => {
          const { parent, after } = newItemPlace(focusId, data)
          startNew(kind, parent, after)
        }}
        onCollapseAll={() => setOpen(new Set())}
        hiddenShown={projection.showHidden}
        onToggleHidden={projection.toggleHidden}
        tasksShown={projection.showTasks}
        onToggleTasks={projection.toggleTasks}
      />
      <div
        className={cn(
          'motion-respond min-h-0 flex-1 overflow-y-auto pb-4 pt-10',
          dropTarget === '' && 'bg-foreground/[0.03]',
        )}
        onClick={(e) => {
          const target = e.target
          if (
            target instanceof Element &&
            target.closest('[data-path], button, input, textarea, select, [contenteditable="true"]')
          )
            return
          setSelected(new Set())
          setAnchor(null)
          setFocusId(null)
        }}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) endDrag()
        }}
        onDrop={onDrop}
      >
        {refused.length > 0 && (
          <Button
            variant="link"
            onClick={() => {
              setSkipped([])
              actions.dismissExportFailures()
            }}
            // amber = the warning role (no token yet); named utilities are gate-legal.
            className="mb-2 h-auto w-full justify-start whitespace-normal p-0 px-3 text-left text-xs text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
          >
            {refused.map((s) => s.name).join(', ')}: {refused[0]!.reason}. Click to dismiss.
          </Button>
        )}
        <Tree
          ref={navRef}
          tree={tree}
          indent={TREE_INDENT}
          aria-label="Files"
          aria-multiselectable
          className="relative px-2"
        >
          {listed}
          {items.length === 0 && pending === null && (
            <p className="px-2 text-xs text-muted-foreground">no notes yet</p>
          )}
        </Tree>
      </div>

      {actions.confirming && (
        <DeleteConfirm
          verb={actions.confirmVerb}
          label={actions.confirming.label}
          refs={actions.confirming.refs}
          linkable={actions.confirming.paths.some((p) => p.endsWith('.md'))}
          onCancel={actions.cancelDelete}
          onConfirm={actions.confirmDelete}
        />
      )}
    </div>
  )
}
