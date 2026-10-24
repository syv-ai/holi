import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { MotionConfig } from "motion/react"
import { Separator } from "motion-panels/react"

import { Panel, PanelGroup } from "@/components/ui/motion-panels"
import { cn } from "@/lib/cn"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import {
  activeSplit,
  dropTab,
  MAX_SPLIT,
  type DropZone,
} from "@/state/shell-workspace"

import { TAB_MIME, tabDragAtom, zoneAt } from "./use-tab-drag"

/**
 * The active strip entry's views side by side, on motion-panels (MIT,
 * Valerii Strilets): one view for a tab, two to four for a split
 * (docs/features/tabs-panes.md, Split view). A horizontal group's one
 * filling panel takes what the sized panels beside it leave, so the layout
 * follows the count:
 *
 * - one view fills;
 * - two: the first fills, the second is sized at the end;
 * - three: sized, filling, sized;
 * - four: sized, filling, sized, sized.
 *
 * **A view never remounts when the layout changes.** Each view renders
 * through a portal into a host element of its own, keyed on its tab key, and
 * whichever slot holds it now adopts that host: a tab made into a split, or
 * a split closing back into a tab, keeps its composer or its document.
 *
 * **Opening and closing fold**, within one split: a member that arrives in a
 * sized slot mounts folded and opens; one that leaves from a sized slot stays
 * as an empty ghost while it folds away. Selecting another entry is not a
 * fold: its views just land. Under reduced motion the library folds at once.
 *
 * **The look.** Members sit edge to edge, square, on `main`'s own ground (no
 * cards, no gutter), parted by a hairline that is the resize handle.
 *
 * **Drops.** While a tab is dragged (`use-tab-drag.ts`) each view lays a
 * target over its content, which shows where the tab would go: the half it
 * would split into, or the whole view it would replace.
 */

const MIN_MEMBER = 240

type Role = "start" | "fill" | "end" | "end2"

function roles(count: number): Role[] {
  if (count <= 1) return ["fill"]
  if (count === 2) return ["fill", "end"]
  if (count === 3) return ["start", "fill", "end"]
  return ["start", "fill", "end", "end2"]
}

/** A view as laid out: its tab key and its share of the width. */
export interface MemberSlot {
  key: string
  share: number
}

/** A member as laid out: the model's, or a ghost folding away. */
type Slot = { member: MemberSlot; ghost: boolean }

function percent(share: number): `${number}%` {
  return `${Math.round(share * 10000) / 100}%`
}

export function PanesView({
  entryId,
  members,
  renderMember,
  onShareChange,
}: {
  /** The active entry's id: folds play only while it stays the same. */
  entryId: string | null
  members: readonly MemberSlot[]
  renderMember: (key: string) => ReactNode
  /** A sized member was resized to `share` of the area. */
  onShareChange: (key: string, share: number) => void
}) {
  const hosts = useRef(new Map<string, HTMLDivElement>())
  function hostFor(key: string): HTMLDivElement {
    let host = hosts.current.get(key)
    if (host === undefined) {
      host = document.createElement("div")
      host.className = "flex h-full min-h-0 w-full min-w-0 flex-col"
      host.dataset.paneHost = key
      hosts.current.set(key, host)
    }
    return host
  }

  // What was laid out last time, to find the members that arrive and leave.
  // (React's "adjusting state when a prop changes": set during render.)
  const [before, setBefore] = useState({ entryId, members })
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set())
  const [ghosts, setGhosts] = useState<{ member: MemberSlot; at: number }[]>([])

  if (before.members !== members || before.entryId !== entryId) {
    setBefore({ entryId, members })
    if (before.entryId !== entryId) {
      // Another entry: its views land as they are.
      if (ghosts.length > 0) setGhosts([])
      if (entering.size > 0) setEntering(new Set())
    } else {
      const keys = new Set(members.map((m) => m.key))
      const old = new Set(before.members.map((m) => m.key))
      const layoutBefore = roles(before.members.length)
      const leaving = before.members
        .map((member, at) => ({ member, at }))
        .filter(
          ({ member, at }) =>
            !keys.has(member.key) && layoutBefore[at] !== "fill"
        )
      const layoutNow = roles(members.length + leaving.length)
      const arriving = members.filter(
        (member, at) => !old.has(member.key) && layoutNow[at] !== "fill"
      )
      if (leaving.length > 0) setGhosts((g) => [...g, ...leaving])
      if (arriving.length > 0) {
        setEntering((e) => new Set([...e, ...arriving.map((m) => m.key)]))
      }
    }
  }

  // An arriving member mounts folded, then opens on the next frame.
  useEffect(() => {
    if (entering.size === 0) return
    const frame = requestAnimationFrame(() => setEntering(new Set()))
    return () => cancelAnimationFrame(frame)
  }, [entering])

  // A ghost goes when its fold ends; a timer stands in should the fold never
  // report (a member already folded).
  function bury(key: string) {
    setGhosts((g) => g.filter((ghost) => ghost.member.key !== key))
  }
  useEffect(() => {
    if (ghosts.length === 0) return
    const timer = window.setTimeout(() => setGhosts([]), 600)
    return () => window.clearTimeout(timer)
  }, [ghosts])

  // Hosts of views no longer laid out are let go: only the active entry's
  // views are mounted.
  useEffect(() => {
    const live = new Set(members.map((m) => m.key))
    for (const key of hosts.current.keys()) {
      if (!live.has(key)) hosts.current.delete(key)
    }
  })

  const slots: Slot[] = members.map((member) => ({ member, ghost: false }))
  for (const { member, at } of [...ghosts].sort((a, b) => a.at - b.at)) {
    if (members.some((m) => m.key === member.key)) continue
    slots.splice(Math.min(at, slots.length), 0, { member, ghost: true })
  }
  const layout = roles(slots.length)
  const count = slots.length
  const maxSize = count === 2 ? "75%" : count === 3 ? "45%" : "35%"
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const dragging = useAtomValue(tabDragAtom)
  const split = activeSplit(ws)
  const full = split !== null && split.views.length >= MAX_SPLIT

  const children: ReactNode[] = []
  slots.forEach(({ member, ghost }, index) => {
    const role = layout[index]!
    if (role === "fill" && index > 0) {
      children.push(<LineSeparator key="sep-start" />)
    }
    if (role === "end" || role === "end2") {
      children.push(<LineSeparator key={`sep-${role}`} />)
    }
    const body = (
      <div className="relative flex h-full min-h-0 w-full min-w-0">
        {ghost ? null : <HostSlot host={hostFor(member.key)} />}
        {ghost || dragging === null ? null : (
          <DropTarget
            target={member.key}
            dragged={dragging}
            full={full}
            onDrop={(key, zone) =>
              setWs((w) => dropTab(w, key, member.key, zone))
            }
            accepts={(key, zone) => dropTab(ws, key, member.key, zone) !== ws}
          />
        )}
      </div>
    )
    if (role === "fill") {
      children.push(
        <Panel key="fill" className="min-h-0 min-w-0">
          {body}
        </Panel>
      )
    } else {
      children.push(
        <Panel
          key={role}
          size={percent(member.share)}
          minSize={MIN_MEMBER}
          maxSize={maxSize}
          collapsed={ghost || entering.has(member.key)}
          onFoldEnd={ghost ? () => bury(member.key) : undefined}
          onSizeChange={(size) => {
            if (!ghost) {
              onShareChange(member.key, Number.parseFloat(size) / 100)
            }
          }}
          className="min-h-0"
        >
          {body}
        </Panel>
      )
    }
  })

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-split={members.length > 1 || undefined}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <PanelGroup
          orientation="horizontal"
          reorder={false}
          className="min-h-0 min-w-0 flex-1"
          data-pane-count={members.length}
        >
          {children}
        </PanelGroup>
      </div>
      {members.map((member) =>
        createPortal(renderMember(member.key), hostFor(member.key), member.key)
      )}
    </MotionConfig>
  )
}

/** Where a view's host is shown: adopted on mount, given back on unmount. */
function HostSlot({ host }: { host: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = ref.current
    if (slot === null) return
    slot.appendChild(host)
    return () => {
      if (host.parentNode === slot) slot.removeChild(host)
    }
  }, [host])
  return <div ref={ref} className="flex h-full min-h-0 w-full min-w-0" />
}

/**
 * The divider between two members: the platform's 1px border line, full
 * height, which is the resize handle. It reaches 4px either side for the
 * pointer, brightens on hover and while dragging, and keeps the library's
 * keyboard (arrows, Shift, Home, End) and its double-click reset.
 */
function LineSeparator() {
  return (
    <Separator
      data-slot="panel-separator"
      aria-label="Resize view"
      className={cn(
        "bg-border relative z-10 w-px shrink-0 cursor-col-resize outline-hidden transition-colors",
        "after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']",
        "hover:bg-ring data-crossing:bg-ring data-resizing:bg-ring focus-visible:bg-ring"
      )}
    />
  )
}

/**
 * Where a dragged tab would land on this view, laid over its content while
 * a tab is dragged: the half it would split into, or the whole view it would
 * replace (every drop, on a full split). A drop that would change nothing is
 * refused, so the pointer says so.
 */
function DropTarget({
  target,
  dragged,
  full,
  accepts,
  onDrop,
}: {
  target: string
  dragged: string
  full: boolean
  accepts: (key: string, zone: DropZone) => boolean
  onDrop: (key: string, zone: DropZone) => void
}) {
  const [zone, setZone] = useState<DropZone | null>(null)
  const setDrag = useSetAtom(tabDragAtom)

  function zoneFor(event: DragEvent<HTMLDivElement>): DropZone | null {
    if (!event.dataTransfer.types.includes(TAB_MIME)) return null
    const where = zoneAt(
      event.clientX,
      event.currentTarget.getBoundingClientRect(),
      false
    )
    return accepts(dragged, where) ? where : null
  }
  const shown = full && zone !== null ? "center" : zone

  return (
    <div
      data-drop-target={target}
      data-drop-zone={zone ?? undefined}
      className={cn(
        "absolute inset-0 z-20",
        zone !== null && "bg-background/40"
      )}
      onDragOver={(event) => {
        const where = zoneFor(event)
        if (where !== zone) setZone(where)
        if (where === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
      }}
      onDragLeave={(event) => {
        const to = event.relatedTarget
        if (!(to instanceof Node) || !event.currentTarget.contains(to)) {
          setZone(null)
        }
      }}
      onDrop={(event) => {
        const where = zoneFor(event)
        const key = event.dataTransfer.getData(TAB_MIME) || dragged
        setZone(null)
        setDrag(null)
        if (where === null) return
        event.preventDefault()
        onDrop(key, where)
      }}
    >
      {shown === null ? null : (
        <div
          aria-hidden="true"
          className={cn(
            "bg-primary/15 ring-primary/50 pointer-events-none absolute inset-y-1.5 ring-2",
            shown === "left" && "start-1.5 w-[calc(50%-0.75rem)]",
            shown === "right" && "end-1.5 w-[calc(50%-0.75rem)]",
            shown === "center" && "inset-x-1.5"
          )}
        />
      )}
    </div>
  )
}
