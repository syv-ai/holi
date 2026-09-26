import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { ChevronRight } from 'lucide-react'
import { APP_SUFFIX } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { DeleteConfirm } from '@/composites'
import { fileIconFor, pathGlyph, pathLabel } from '@/composites/file-icons'
import { cn } from '@/lib/cn'
import { canMoveInto, dropFolder, rangeBetween, typeahead, visibleRows } from '@/lib/tree-view'
import { buildTreeData, ROOT_ID, type TreeItemData } from '@/lib/tree-data'
import {
  ancestorsOf,
  joinPath,
  parentOf,
  renameBasenameRange,
  withMdExtension,
} from '@/lib/tree-paths'
import { useArrivals } from '@/lib/use-arrivals'
import { Button, ContextMenu, ContextMenuTrigger, Input } from '@/primitives'
import { unregisteredAppPathsAtom } from '@/state/apps'
import { todayDailyPathAtom } from '@/state/daily'
import { revealRequestAtom } from '@/state/reveal'
import { todayLinkCountAtom } from '@/state/tasks'
import {
  activeRemoteAtom,
  createFolderAtom,
  createNoteAtom,
  importFilesAtom,
  renameNoteAtom,
  vaultsAtom,
} from '@/state/vaults'
import { ExplorerHeader } from './ExplorerHeader'
import { RowMenu } from './RowMenu'
import { useExplorerActions } from './useExplorerActions'
import { useTreeProjection } from './useTreeProjection'

/**
 * The explorer (docs/features/file-tree.md): root entries as headings, the
 * focused one marked by a bar at their left that slides between them, and each
 * open folder's contents hung from a rounded connector whose path to the open
 * file is drawn in the brand colour.
 *
 * An app bundle (D107) is a folder that behaves as a file: a click opens the
 * app, and its files show only when it is expanded, by → or Show Contents.
 *
 * A view of the snapshot that owns no vault data. Its rules (which rows show,
 * ranges, typeahead, where a drop may go) are in `lib/tree-view.ts`; this is
 * state, DOM and wiring.
 */

/** `single` keeps one path open, as the reference does; `multi` lets folders stay open. */
export type TreeExpansion = 'single' | 'multi'

const ROW = 22
const MID = ROW / 2
const RADIUS = 6
/** The elbow's run from the rail to where the icon starts. */
const ELBOW = 20
/** How long a drag hovers on a closed folder before it opens. */
const SPRING_OPEN_MS = 600
/** How long typed letters keep adding to one typeahead query. */
const TYPEAHEAD_MS = 700

/**
 * A row's name, boxed from its x-height to its baseline (`text-box`), so the
 * row's centring puts the icon on the middle of the letters rather than of
 * the line, which sits a couple of pixels higher. It clips sideways only: a
 * vertical clip would cut the ascenders the trim leaves outside the box.
 */
const LABEL =
  'min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap [text-box:trim-both_ex_alphabetic]'
/**
 * A tree row is a Button with none of a button's chrome: no fill, no press.
 * Block-level `flex`, not the Button's `inline-flex`: an inline row sits on a
 * line box, whose baseline strut adds a few pixels under a row with no glyph.
 */
/** A folder for grouping: an app sits with the files, as it sorts. */
const isGroupFolder = (node: TreeItemData | undefined) => node?.isFolder === true && !node.isApp

const ROW_RESET =
  'flex h-auto w-full justify-start rounded-none px-0 font-normal active:scale-100 hover:bg-transparent dark:hover:bg-transparent'

/** A folder's contents, rendered while open and through the closing transition. */
function Disclose({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  if (!mounted) return null
  return (
    <div
      data-slot="disclose"
      data-state={open ? 'open' : 'closed'}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !open) setMounted(false)
      }}
    >
      <div role="group">{children}</div>
    </div>
  )
}

/**
 * The inline name field, for a rename and for a new file or folder. Enter
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
      className="h-[20px] min-w-0 flex-1 rounded border-primary bg-background px-1 py-0 text-[13px] shadow-none"
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

/** One child's slice of its group's connector: the rail past it and its elbow. */
function Connector({
  last,
  lit,
  litThrough,
}: {
  last: boolean
  lit: boolean
  litThrough: boolean
}) {
  const elbow = `M 0.5 0 L 0.5 ${MID - RADIUS} Q 0.5 ${MID} ${RADIUS + 0.5} ${MID} L ${ELBOW - 4} ${MID}`
  return (
    <>
      {!last && <span aria-hidden className="absolute bottom-0 left-0 top-0 w-px bg-divider" />}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-0 top-0"
        width={ELBOW}
        height={ROW}
        fill="none"
        strokeWidth={1}
        strokeLinecap="round"
      >
        <path d={elbow} className={lit ? 'stroke-brand' : 'stroke-divider'} />
      </svg>
      {/* Last, so no grey elbow above paints over the lit rail. */}
      {litThrough && <span aria-hidden className="absolute bottom-0 left-0 top-0 w-px bg-brand" />}
    </>
  )
}

export function FileTree({
  activePath,
  onOpenPreview,
  onOpenPinned,
  onOpenInNewPane,
  expansion = 'single',
}: {
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
  onOpenInNewPane: (path: string) => void
  expansion?: TreeExpansion
}) {
  const projection = useTreeProjection()
  const { visible, taskByPath, iconByPath, ignored } = projection
  const actions = useExplorerActions(projection.docPaths)
  const data = useMemo(
    () => buildTreeData(visible.paths, [...visible.dirs, ...actions.pendingFolders]),
    [visible, actions.pendingFolders],
  )
  const renameNote = useSetAtom(renameNoteAtom)
  const createNote = useSetAtom(createNoteAtom)
  const createFolder = useSetAtom(createFolderAtom)
  const importFiles = useSetAtom(importFilesAtom)
  const revealRequest = useAtomValue(revealRequestAtom)
  const todayDailyPath = useAtomValue(todayDailyPathAtom)
  const todayLinkCount = useAtomValue(todayLinkCountAtom)
  const unfinished = useAtomValue(unregisteredAppPathsAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vault = useAtomValue(vaultsAtom).find((v) => v.remote === activeRemote)
  const vaultPrefix = vault ? `${vault.path}/` : null

  const [open, setOpen] = useState<Set<string>>(() => new Set())
  /** The root entry the bar marks: the last one used, else the open file's. */
  const [focusRoot, setFocusRoot] = useState<string | null>(null)
  /** The selection, and the row a ⇧ range runs from. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  /** The row that takes Tab: one focusable row, moved by the arrow keys. */
  const [focusId, setFocusId] = useState<string | null>(null)
  /** The row whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** A new file or folder being named, and the folder it lands in ('' = root). */
  const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)
  /** The folder a drag from the OS would land in ('' = root), while one is over the tree. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** Files the last drop refused, held until dismissed or superseded: a file that
   *  silently did not arrive is the worst outcome of an import. */
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([])

  const rows = useMemo(() => visibleRows(data, open), [data, open])
  const { arrivalProps } = useArrivals(useMemo(() => rows.map((r) => r.id), [rows]))

  const navRef = useRef<HTMLDivElement>(null)
  const rowEl = (id: string) =>
    navRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(id)}"]`) ?? null

  const openBranch = (path: string, andSelf: boolean) => {
    const chain = [...ancestorsOf(path), ...(andSelf ? [path] : [])]
    setOpen((prev) => (expansion === 'single' ? new Set(chain) : new Set([...prev, ...chain])))
  }

  // Opening a file (from anywhere: a tab, a link, the palette) opens its
  // branch and moves the focus to its root.
  useEffect(() => {
    if (activePath === null) return
    openBranch(activePath, false)
    setFocusRoot(activePath.split('/')[0]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, expansion])

  const onPath = (id: string) =>
    activePath !== null && (id === activePath || activePath.startsWith(`${id}/`))

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
    setFocusRoot(path.split('/')[0]!)
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
    // An app is named without its `.app`, as a note is without its `.md`.
    if (node.isApp) return actions.renameFolder(from, `${name}${APP_SUFFIX}`)
    if (node.isFolder) return actions.renameFolder(from, name)
    const to = joinPath(parentOf(from), withMdExtension(name))
    if (to !== from) void renameNote({ from, to })
  }

  /** Open the name input inside `parent`, which opens so the input shows. */
  const startNew = (kind: 'file' | 'folder', parent: string) => {
    if (parent !== '') openBranch(parent, true)
    setPending({ kind, parent })
  }

  const create = (name: string) => {
    if (pending === null) return
    if (pending.kind === 'folder') {
      // Shown at once, and made real with a `.gitkeep` so it persists.
      const folder = joinPath(pending.parent, name)
      actions.addPendingFolder(folder)
      void createFolder(folder)
    } else {
      const path = joinPath(pending.parent, withMdExtension(name))
      void createNote(path).then(() => onOpenPreview(path))
    }
    setPending(null)
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
    setFocusRoot(id.split('/')[0]!)
    // An unfinished app has nothing to open yet, so it shows its files instead.
    if (node.isFolder && (!node.isApp || unfinished.includes(id))) toggle(id)
    else if (e.metaKey) onOpenInNewPane(id)
    else onOpenPreview(id)
  }

  const typed = useRef({ query: '', at: 0 })

  /** A key on a focused row. Returns whether it acted, so the caller can claim it. */
  const rowKey = (e: KeyboardEvent, id: string, node: TreeItemData): boolean => {
    const { isFolder, isApp } = node
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
      else if (e.code === 'KeyV') actions.paste(isFolder && !isApp ? id : parentOf(id))
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
        // Opens a folder, then steps into it. An app's contents open the same way.
        if (isFolder && !open.has(id)) toggle(id)
        else if (isFolder && next && parentOf(next.id) === id) moveTo(next.id)
        break
      case 'ArrowLeft':
        // Closes a folder, then steps out to the parent.
        if (isFolder && open.has(id)) toggle(id)
        else moveTo(parentOf(id) || undefined)
        break
      case 'Enter':
        if (isFolder && (!isApp || unfinished.includes(id))) toggle(id)
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
  // is an import. The folder under the pointer is the destination.
  const springOpen = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const endDrag = () => {
    if (springOpen.current) clearTimeout(springOpen.current.timer)
    springOpen.current = null
    setDropTarget(null)
  }
  /** The row under a drag event, if any, and the folder a drop there lands in. */
  const dropAt = (e: DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    const id = row?.getAttribute('data-path') ?? null
    // A drop on an app lands beside it, as on a file, not among its files.
    const isFolder = id !== null && data[id]?.isFolder === true && !data[id]?.isApp
    return { id, isFolder, dest: dropFolder(id, isFolder) }
  }
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { id, isFolder, dest } = dropAt(e)
    setDropTarget(dest)
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
    const { dest } = dropAt(e)
    endDrag()
    const sources = [...e.dataTransfer.files].map((f) => window.holi.pathForFile(f))
    const mine = vaultPrefix ? sources.filter((p) => p.startsWith(vaultPrefix)) : []
    const theirs = sources.filter((p) => !mine.includes(p))
    const moving = mine.map((p) => p.slice(vaultPrefix!.length))
    if (moving.length > 0 && canMoveInto(moving, dest)) actions.moveInto(moving, dest)
    if (theirs.length > 0) void importFiles(theirs, dest).then(setSkipped)
  }

  // The bar slides to the focused root row; measured, since rows above it may
  // be open and of any height.
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const row = focusRoot
      ? navRef.current?.querySelector<HTMLElement>(
          `:scope > div > [data-path="${CSS.escape(focusRoot)}"]`,
        )
      : null
    setBar(row ? { top: row.offsetTop, height: row.offsetHeight } : null)
  }, [focusRoot, data, open])

  /**
   * A note is the default row: no `.md` and no glyph (its slot stays, so names
   * line up). Everything else keeps its extension and type glyph. The rule is
   * `pathLabel`/`pathGlyph`, which the tabs share.
   */
  const label = (id: string, node: TreeItemData) =>
    node.isFolder && !node.isApp ? node.name : pathLabel(id)

  /**
   * What a row leads with: a folder's chevron, or a file's type glyph in the
   * chevron's column, so the two read apart at a glance. On the open file's
   * path it is brand, file and every folder above it, so the chevrons trace
   * the way down alongside the connector. `!` beats Button's own svg sizing.
   */
  const lead = (id: string, node: TreeItemData, isOpen: boolean) => {
    const slot = cn(
      'motion-respond flex w-3.5 shrink-0 justify-center [&_svg]:size-3.5!',
      onPath(id) ? 'text-brand' : 'text-muted-foreground group-hover:text-foreground',
      ignored.has(id) && 'opacity-50',
    )
    const emoji = iconByPath.get(id)
    // An app leads with its glyph, as a file does; the chevron joins it only
    // while its contents are shown, which is when there is something to close.
    if (node.isApp) {
      return (
        <>
          {isOpen && (
            <span className={slot}>
              <ChevronRight className="motion-respond size-3! rotate-90" />
            </span>
          )}
          <span data-slot="row-icon" className={slot}>
            {pathGlyph(id, { emoji })}
          </span>
        </>
      )
    }
    if (!node.isFolder) {
      return (
        <span data-slot="row-icon" className={slot}>
          {pathGlyph(id, { emoji, task: taskByPath.get(id)?.status })}
        </span>
      )
    }
    return (
      <>
        <span className={slot}>
          <ChevronRight
            className="motion-respond size-3!"
            style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}
          />
        </span>
        {/* A chosen icon still shows; the plain folder glyph would repeat the chevron. */}
        {emoji && (
          <span data-slot="row-icon" className={slot}>
            {fileIconFor(id, emoji)}
          </span>
        )}
      </>
    )
  }

  /**
   * A row: its button under the row menu, or, while it is being renamed, the
   * same row holding the name field (a field cannot sit inside a button).
   * A selection shows only once it is more than one row: a single one is
   * already said by the open file's weight and the focus ring. A gitignored
   * row dims its contents, not itself, so a selection behind it stays solid.
   */
  const row = (id: string, node: TreeItemData, className: string, style?: CSSProperties) => {
    const isOpen = node.isFolder && open.has(id)
    const isCut = actions.clipboard?.mode === 'cut' && actions.clipboard.paths.includes(id)
    if (renaming === id)
      return (
        <div data-path={id} className={cn(className, 'flex items-center')} style={style}>
          {lead(id, node, isOpen)}
          <NameInput
            // As listed: a note without its `.md`, which the rename adds back.
            initial={label(id, node)}
            onCommit={(name) => rename(id, node, name)}
            onCancel={() => setRenaming(null)}
          />
        </div>
      )
    const arrival = arrivalProps(id)
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Button
            variant="ghost"
            data-path={id}
            role="treeitem"
            aria-level={id.split('/').length}
            aria-selected={selected.has(id)}
            aria-expanded={node.isFolder ? isOpen : undefined}
            tabIndex={id === (focusId ?? rows[0]?.id) ? 0 : -1}
            draggable
            onDragStart={(e) => {
              e.preventDefault()
              if (vaultPrefix) window.holi.startDrag(targets(id).map((p) => vaultPrefix + p))
            }}
            onClick={(e) => onRowClick(e, id, node)}
            onDoubleClick={() => (!node.isFolder || node.isApp) && onOpenPinned(id)}
            onKeyDown={(e) => {
              if (rowKey(e, id, node)) e.preventDefault()
            }}
            className={cn(
              ROW_RESET,
              className,
              // Hover-proof: ROW_RESET clears the ghost hover fill, which would
              // otherwise wipe these under the pointer.
              selected.size > 1 &&
                selected.has(id) &&
                'rounded-md bg-accent/60 hover:bg-accent/60 dark:hover:bg-accent/60',
              dropTarget === id && 'rounded-md bg-accent hover:bg-accent dark:hover:bg-accent',
              isCut && 'opacity-40',
              arrival.className,
            )}
            style={{ ...style, ...arrival.style }}
          >
            {lead(id, node, isOpen)}
            <span
              data-slot="row-name"
              className={cn(
                LABEL,
                taskByPath.get(id)?.status === 'done' && 'line-through',
                (ignored.has(id) || unfinished.includes(id)) && 'opacity-50',
              )}
            >
              {label(id, node)}
            </span>
            {/* Today's daily, marked where it lives (docs/features/daily-notes.md). */}
            {id === todayDailyPath && (
              <span className="shrink-0 text-[11px] text-brand">
                today{todayLinkCount > 0 && ` · ${todayLinkCount}`}
              </span>
            )}
          </Button>
        </ContextMenuTrigger>
        <RowMenu
          path={id}
          isFolder={node.isFolder}
          app={node.isApp ? { open: isOpen, unfinished: unfinished.includes(id) } : null}
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

  /** The name input for a new file or folder, as a row of the group it joins. */
  const pendingInput = (className: string, style?: CSSProperties) =>
    pending && (
      <div className={cn(className, 'flex items-center')} style={style}>
        <span className="flex w-3.5 shrink-0 justify-center text-muted-foreground">
          {pending.kind === 'folder' && <ChevronRight className="size-3" />}
        </span>
        <NameInput
          initial=""
          placeholder={pending.kind === 'folder' ? 'folder name' : 'note name'}
          onCommit={create}
          onCancel={() => setPending(null)}
        />
      </div>
    )

  /** A folder's children, hung from its connector; a new name's input first. */
  const group = (parent: string) => {
    const children = data[parent]?.children ?? []
    const litIndex = children.findIndex(onPath)
    const nested = (id: string) =>
      cn(
        'group gap-2 pr-3 text-[13px]',
        id === activePath
          ? 'font-semibold text-foreground'
          : onPath(id)
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground',
      )
    return (
      <div className="relative py-1">
        {pending?.parent === parent && (
          <div className="relative" style={{ paddingLeft: ELBOW }}>
            <Connector last={children.length === 0} lit={false} litThrough={litIndex >= 0} />
            {pendingInput('gap-2 pr-3', { height: ROW })}
          </div>
        )}
        {children.map((id, i) => {
          const node = data[id]
          if (!node) return null
          return (
            <div key={id} className="relative" style={{ paddingLeft: ELBOW }}>
              <Connector
                last={i === children.length - 1}
                lit={i === litIndex}
                litThrough={litIndex > i}
              />
              {row(id, node, nested(id), { height: ROW })}
              {node.isFolder && (
                // Hangs from the centre of the chevron above it.
                <div style={{ marginLeft: 7 }}>
                  <Disclose open={open.has(id)}>{group(id)}</Disclose>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const roots = data[ROOT_ID]?.children ?? []
  /** Everything the last import or export refused, in one list. */
  const refused = [...skipped, ...actions.exportFailures]

  return (
    <div className="group/explorer relative flex min-h-0 flex-1 flex-col">
      <ExplorerHeader
        onNewFile={() => startNew('file', '')}
        onNewFolder={() => startNew('folder', '')}
        onCollapseAll={() => setOpen(new Set())}
        hiddenShown={projection.showHidden}
        onToggleHidden={projection.toggleHidden}
        tasksShown={projection.showTasks}
        onToggleTasks={projection.toggleTasks}
      />
      <div
        className={cn(
          'motion-respond min-h-0 flex-1 overflow-y-auto pb-4 pt-10',
          dropTarget === '' && 'bg-primary/5',
        )}
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
            className="mb-2 h-auto w-full justify-start whitespace-normal p-0 px-3 text-left text-[11px] text-amber-300/90 hover:text-amber-200"
          >
            {refused.map((s) => s.name).join(', ')}: {refused[0]!.reason}. Click to dismiss.
          </Button>
        )}
        <div
          ref={navRef}
          role="tree"
          aria-label="Files"
          aria-multiselectable
          className="relative flex flex-col"
        >
          {bar && (
            <span
              aria-hidden
              className="motion-respond absolute top-0 w-0.5 rounded-full bg-brand"
              style={{
                left: 11.5,
                transform: `translateY(${bar.top + 6}px)`,
                height: bar.height - 12,
              }}
            />
          )}
          {pending?.parent === '' && pendingInput('h-7 gap-2 pl-6 pr-3 text-[15px]')}
          {roots.map((id, i) => {
            const node = data[id]
            if (!node) return null
            return (
              <div
                key={id}
                // A break between the root's folders and its loose files
                // (folders sort first), so the two groups read apart.
                className={cn(
                  !isGroupFolder(node) && i > 0 && isGroupFolder(data[roots[i - 1]!]) && 'mt-3',
                )}
              >
                {row(
                  id,
                  node,
                  cn(
                    'group h-7 gap-2 pl-6 pr-3 text-[15px] font-medium tracking-tight',
                    focusRoot === id || onPath(id)
                      ? 'text-foreground'
                      : 'text-muted-foreground/70 hover:text-foreground',
                  ),
                )}
                {node.isFolder && (
                  // Hangs from the centre of the heading's chevron.
                  <div style={{ marginLeft: 31 }}>
                    <Disclose open={open.has(id)}>{group(id)}</Disclose>
                  </div>
                )}
              </div>
            )
          })}
          {roots.length === 0 && <p className="px-6 text-xs text-muted-foreground">no notes yet</p>}
        </div>
      </div>

      {actions.confirming && (
        <DeleteConfirm
          verb={actions.confirmVerb}
          label={actions.confirming.label}
          refs={actions.confirming.refs}
          onCancel={actions.cancelDelete}
          onConfirm={actions.confirmDelete}
        />
      )}
    </div>
  )
}
