import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { fileKind } from '@holi/shared'
import { fileIconFor } from '@/composites/file-icons'
import { cn } from '@/lib/cn'
import { Button } from '@/primitives'
import { ROOT_ID, type TreeItemData } from '@/lib/tree-data'
import { ancestorsOf } from '@/lib/tree-paths'
import { ExplorerHeader } from './ExplorerHeader'
import { TaskIcon } from './icons'
import { useTreeProjection } from './useTreeProjection'

/**
 * The explorer rebuilt as a navigation tree, after reloop's product nav: root
 * entries as large headings on a rail, the focused one marked by a bar that
 * slides between them, and each open folder's contents hung from a rounded
 * connector whose path to the open file is drawn in the brand colour.
 *
 * An experiment beside `FileTree`: it opens and navigates, and none of the
 * editing (menu, rename, drag, selection, keys) is ported yet.
 */

/** `single` keeps one path open, as the reference does; `multi` lets folders stay open. */
export type NavTreeExpansion = 'single' | 'multi'

const ROW = 24
const MID = ROW / 2
const RADIUS = 6
/** The elbow's run from the rail to where the icon starts. */
const ELBOW = 20
/** A tree row is a Button with none of a button's chrome: no fill, no press. */
const ROW_RESET =
  'h-auto w-full justify-start rounded-none px-0 font-normal active:scale-100 hover:bg-transparent dark:hover:bg-transparent'

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
  expansion = 'single',
  onLeaveExperiment,
}: {
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
  expansion?: NavTreeExpansion
  onLeaveExperiment: () => void
}) {
  const projection = useTreeProjection()
  const { data, taskByPath, iconByPath, ignored } = projection

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

  // The bar slides to the focused root row; measured, since rows above it may
  // be open and of any height.
  const navRef = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const row = focusRoot
      ? navRef.current?.querySelector<HTMLElement>(`[data-root-row="${CSS.escape(focusRoot)}"]`)
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

  /** A folder's children, hung from its connector. */
  const group = (parent: string) => {
    const children = data[parent]?.children ?? []
    const litIndex = children.findIndex(onPath)
    return (
      <div className="relative py-1">
        {children.map((id, i) => {
          const node = data[id]
          if (!node) return null
          const isOpen = node.isFolder && open.has(id)
          const active = id === activePath
          return (
            <div key={id} className="relative" style={{ paddingLeft: ELBOW }}>
              <Connector
                last={i === children.length - 1}
                lit={i === litIndex}
                litThrough={litIndex > i}
              />
              <Button
                variant="ghost"
                data-path={id}
                onClick={() => click(id, node.isFolder)}
                onDoubleClick={() => !node.isFolder && onOpenPinned(id)}
                className={cn(
                  ROW_RESET,
                  'group gap-2 pr-3 text-[13px]',
                  active
                    ? 'font-semibold text-foreground'
                    : onPath(id)
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  ignored.has(id) && 'opacity-50',
                )}
                style={{ height: ROW }}
              >
                {lead(id, node, isOpen)}
                <span
                  className={cn(
                    'truncate',
                    taskByPath.get(id)?.status === 'done' && 'line-through',
                  )}
                >
                  {label(id, node)}
                </span>
              </Button>
              {node.isFolder && (
                // Hangs from the centre of the chevron above it.
                <div style={{ marginLeft: 7 }}>
                  <Disclose open={isOpen}>{group(id)}</Disclose>
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
                <Button
                  variant="ghost"
                  data-path={id}
                  data-root-row={id}
                  onClick={() => click(id, node.isFolder)}
                  onDoubleClick={() => !node.isFolder && onOpenPinned(id)}
                  className={cn(
                    ROW_RESET,
                    'group h-8 gap-2 pl-6 pr-3 text-[15px] font-medium tracking-tight',
                    focused || onPath(id)
                      ? 'text-foreground'
                      : 'text-muted-foreground/70 hover:text-foreground',
                    ignored.has(id) && 'opacity-50',
                  )}
                >
                  {lead(id, node, isOpen)}
                  <span className="truncate">{label(id, node)}</span>
                </Button>
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
    </div>
  )
}
