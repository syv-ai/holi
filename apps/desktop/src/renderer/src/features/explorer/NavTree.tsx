import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronRight } from 'lucide-react'
import { fileKind } from '@holi/shared'
import { useSetAtom } from 'jotai'
import { DeleteConfirm } from '@/composites'
import { fileIconFor } from '@/composites/file-icons'
import { cn } from '@/lib/cn'
import { Button, ContextMenu, ContextMenuTrigger, Input } from '@/primitives'
import { buildTreeData, ROOT_ID, type TreeItemData } from '@/lib/tree-data'
import {
  ancestorsOf,
  joinPath,
  parentOf,
  renameBasenameRange,
  withMdExtension,
} from '@/lib/tree-paths'
import { createFolderAtom, createNoteAtom, renameNoteAtom } from '@/state/vaults'
import { ExplorerHeader } from './ExplorerHeader'
import { TaskIcon } from './icons'
import { RowMenu } from './RowMenu'
import { useExplorerActions } from './useExplorerActions'
import { useTreeProjection } from './useTreeProjection'

/**
 * The explorer rebuilt as a navigation tree, after reloop's product nav: root
 * entries as large headings on a rail, the focused one marked by a bar that
 * slides between them, and each open folder's contents hung from a rounded
 * connector whose path to the open file is drawn in the brand colour.
 *
 * An experiment beside `FileTree`. Ported so far: opening, the row menu with
 * rename and create inline, and the row keys the menu advertises. Not yet:
 * drag, multi-select, Finder drops, reveal.
 */

/** `single` keeps one path open, as the reference does; `multi` lets folders stay open. */
export type NavTreeExpansion = 'single' | 'multi'

const ROW = 22
const MID = ROW / 2
const RADIUS = 6
/** The elbow's run from the rail to where the icon starts. */
const ELBOW = 20
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
      <div>{children}</div>
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

export function NavTree({
  activePath,
  onOpenPreview,
  onOpenPinned,
  onOpenInNewPane,
  expansion = 'single',
  onLeaveExperiment,
}: {
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
  onOpenInNewPane: (path: string) => void
  expansion?: NavTreeExpansion
  onLeaveExperiment: () => void
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

  /** The row whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** A new file or folder being named, and the folder it lands in ('' = root). */
  const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)

  const [open, setOpen] = useState<Set<string>>(() => new Set())
  /** The root entry the bar marks: the last one used, else the open file's. */
  const [focusRoot, setFocusRoot] = useState<string | null>(null)

  // Opening a file (from anywhere: a tab, a link, the palette) opens its
  // branch and moves the focus to its root.
  useEffect(() => {
    if (activePath === null) return
    const chain = ancestorsOf(activePath)
    setOpen((prev) => (expansion === 'single' ? new Set(chain) : new Set([...prev, ...chain])))
    setFocusRoot(chain[0] ?? activePath)
  }, [activePath, expansion])

  const onPath = (id: string) =>
    activePath !== null && (id === activePath || activePath.startsWith(`${id}/`))

  const toggle = (id: string) => {
    setOpen((prev) => {
      if (prev.has(id)) {
        const next = new Set([...prev].filter((p) => p !== id && !p.startsWith(`${id}/`)))
        return next
      }
      if (expansion === 'single') return new Set([...ancestorsOf(id), id])
      return new Set([...prev, id])
    })
  }

  const click = (id: string, isFolder: boolean) => {
    const root = id.split('/')[0]!
    setFocusRoot(root)
    if (isFolder) toggle(id)
    else onOpenPreview(id)
  }

  const rename = (from: string, isFolder: boolean, name: string) => {
    setRenaming(null)
    if (isFolder) return actions.renameFolder(from, name)
    const to = joinPath(parentOf(from), withMdExtension(name))
    if (to !== from) void renameNote({ from, to })
  }

  /** Open the name input inside `parent`, which opens so the input shows. */
  const startNew = (kind: 'file' | 'folder', parent: string) => {
    if (parent !== '') setOpen((prev) => new Set([...prev, ...ancestorsOf(parent), parent]))
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

  /** The keys the row menu advertises, on the focused row. */
  const rowKeys = (id: string, isFolder: boolean) => (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    const dest = isFolder ? id : parentOf(id)
    if (e.key === 'F2') setRenaming(id)
    else if (e.key === 'Delete' || e.key === 'Backspace') actions.startDelete([id], isFolder)
    else if (mod && e.code === 'KeyX') actions.cut([id])
    else if (mod && e.code === 'KeyC') actions.copy([id])
    else if (mod && e.code === 'KeyV') actions.paste(dest)
    else if (mod && e.code === 'KeyD') actions.duplicate([id])
    else return
    e.preventDefault()
  }

  /**
   * A row: its button under the row menu, or, while it is being renamed, the
   * same row holding the name field (a field cannot sit inside a button).
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
            onCommit={(name) => rename(id, node.isFolder, name)}
            onCancel={() => setRenaming(null)}
          />
        </div>
      )
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Button
            variant="ghost"
            data-path={id}
            onClick={() => click(id, node.isFolder)}
            onDoubleClick={() => !node.isFolder && onOpenPinned(id)}
            onKeyDown={rowKeys(id, node.isFolder)}
            className={cn(ROW_RESET, className, isCut && 'opacity-40')}
            style={style}
          >
            {lead(id, node, isOpen)}
            <span className={cn(LABEL, taskByPath.get(id)?.status === 'done' && 'line-through')}>
              {label(id, node)}
            </span>
          </Button>
        </ContextMenuTrigger>
        <RowMenu
          path={id}
          isFolder={node.isFolder}
          targets={[id]}
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

  // The bar slides to the focused root row; measured, since rows above it may
  // be open and of any height.
  const navRef = useRef<HTMLDivElement>(null)
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
   * line up). Everything else keeps its extension and type glyph.
   */
  const label = (id: string, node: TreeItemData) =>
    !node.isFolder && fileKind(id) === 'markdown' ? node.name.replace(/\.md$/i, '') : node.name

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
    )
    const emoji = iconByPath.get(id)
    if (!node.isFolder) {
      const task = taskByPath.get(id)
      return (
        <span className={slot}>
          {emoji ? (
            fileIconFor(id, emoji)
          ) : task ? (
            <TaskIcon status={task.status} />
          ) : fileKind(id) === 'markdown' ? null : (
            fileIconFor(id)
          )}
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
        {emoji && <span className={slot}>{fileIconFor(id, emoji)}</span>}
      </>
    )
  }

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
        ignored.has(id) && 'opacity-50',
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
        experiment={{ on: true, onToggle: onLeaveExperiment }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-4 pt-10">
        <nav ref={navRef} aria-label="Files" className="relative flex flex-col">
          {/* The rail the bar runs on. */}
          <span aria-hidden className="absolute bottom-0 left-3 top-0 w-px bg-divider" />
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
            const isOpen = node.isFolder && open.has(id)
            const focused = focusRoot === id
            return (
              <div
                key={id}
                // A break between the root's folders and its loose files
                // (folders sort first), so the two groups read apart.
                className={cn(!node.isFolder && i > 0 && data[roots[i - 1]!]?.isFolder && 'mt-3')}
              >
                {row(
                  id,
                  node,
                  cn(
                    'group h-7 gap-2 pl-6 pr-3 text-[15px] font-medium tracking-tight',
                    focused || onPath(id)
                      ? 'text-foreground'
                      : 'text-muted-foreground/70 hover:text-foreground',
                    ignored.has(id) && 'opacity-50',
                  ),
                )}
                {node.isFolder && (
                  // Hangs from the centre of the heading's chevron.
                  <div style={{ marginLeft: 31 }}>
                    <Disclose open={isOpen}>{group(id)}</Disclose>
                  </div>
                )}
              </div>
            )
          })}
        </nav>
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
