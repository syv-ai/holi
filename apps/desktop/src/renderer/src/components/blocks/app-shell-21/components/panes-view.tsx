import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
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
  entryOf,
  insertIntoActive,
  isSplit,
  MAX_SPLIT,
  openTab,
  type ShellWorkspace,
} from "@/state/shell-workspace"

import { TabMark } from "./site-header"
import { useTabLook } from "./tab-look"
import {
  insertPreview,
  notePlaced,
  slotAt,
  TAB_MIME,
  tabDragAtom,
  type DropSlot,
} from "./use-tab-drag"

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
 * **Drops make room.** While a view is dragged (`use-tab-drag.ts`) one
 * transparent catcher lies over the content, and the views slide apart to
 * open a gap where the dragged view would land, its mark and title in it
 * (`slotAt` says where, `insertPreview` how far each slides). Only
 * transforms move, so a heavy view (an editor, a terminal) is never laid
 * out again mid-drag. The drop commits that layout and lands it at once,
 * the gap's share and place being what the drop gives the newcomer. A
 * member's middle third replaces it, and a full split only replaces.
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

/** The members as the drag found them: their keys and edges, in pixels from
 *  the content's left edge (`slotAt`'s `edges`). */
interface Geometry {
  keys: string[]
  edges: number[]
}

/** What a drag over the content shows, for the slot under the pointer. */
type Preview =
  /** A gap opens at edge `index`; the members slide by `shifts`. `fills`
   *  is the view that will fill the rest when that is not what is there
   *  now (the tab in front dragged to its own edge splits with its
   *  neighbour). */
  | {
      kind: "insert"
      index: number
      gapStart: number
      gapWidth: number
      shifts: number[]
      fills: string | null
    }
  /** A split's own member moves to edge `index`: a line there, nothing
   *  slides (the count stays). */
  | { kind: "move"; index: number; from: number }
  /** The member at `index` is replaced (or swapped), whole. */
  | { kind: "replace"; index: number }

/** The house curve for what slides: the reveal's 200ms, no bounce, and
 *  nothing under reduced motion. */
const SLIDE =
  "transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"

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

  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const dragging = useAtomValue(tabDragAtom)
  const setDrag = useSetAtom(tabDragAtom)
  const look = useTabLook()

  /** A drop just committed: its layout lands at once, no fold, no slide
   *  back, on a group mounted afresh (`landings` is its key), so the
   *  library sizes every panel at its share rather than animating from the
   *  old widths (the views keep their hosts, so nothing remounts). */
  const [landing, setLanding] = useState(false)
  const [landings, setLandings] = useState(0)

  // What was laid out last time, to find the members that arrive and leave.
  // (React's "adjusting state when a prop changes": set during render.)
  const [before, setBefore] = useState({ entryId, members })
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set())
  const [ghosts, setGhosts] = useState<{ member: MemberSlot; at: number }[]>([])

  if (before.members !== members || before.entryId !== entryId) {
    setBefore({ entryId, members })
    if (before.entryId !== entryId || landing) {
      // Another entry, or a drop's layout: its views land as they are.
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

  // A landing lasts until the new group has sized its panels.
  useEffect(() => {
    if (!landing) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setLanding(false))
    })
    return () => cancelAnimationFrame(frame)
  }, [landing])

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

  // ---------------------------------------------------------------- drops

  const area = useRef<HTMLDivElement>(null)
  /** Measured as the drag arrives over the content, kept for the drag: the
   *  zones never move under the pointer while the views slide. */
  const geometry = useRef<Geometry | null>(null)
  /** The slot under the pointer, as `kind:index`, and the drop it makes. */
  const under = useRef<{ id: string | null; next: ShellWorkspace | null }>({
    id: null,
    next: null,
  })
  const [preview, setPreview] = useState<Preview | null>(null)

  // A drag over: everything back as it was. A drag whose source went away
  // mid-drag (a row re-rendered) never reports its end, but the first
  // pointer move after it does.
  useEffect(() => {
    if (dragging === null) {
      geometry.current = null
      under.current = { id: null, next: null }
      setPreview(null)
      return
    }
    const over = () => setDrag(null)
    window.addEventListener("pointermove", over)
    return () => window.removeEventListener("pointermove", over)
  }, [dragging, setDrag])

  function measure(): Geometry | null {
    const root = area.current
    if (root === null) return null
    const left = root.getBoundingClientRect().left
    const bodies = [
      ...root.querySelectorAll<HTMLElement>("[data-preview-member]"),
    ]
    if (bodies.length === 0) return null
    const rects = bodies.map((body) => body.getBoundingClientRect())
    return {
      keys: bodies.map((body) => body.dataset.previewMember!),
      edges: [
        ...rects.map((rect) => rect.left - left),
        rects[rects.length - 1]!.right - left,
      ],
    }
  }

  /** The drop a slot makes, and what it shows; null when it changes
   *  nothing. */
  function plan(
    key: string,
    slot: DropSlot,
    at: Geometry
  ): { next: ShellWorkspace; show: Preview } | null {
    if (ws.active === null) {
      // The empty strip's view: whatever is dropped opens there.
      const next = openTab(ws, key)
      return next === ws ? null : { next, show: { kind: "replace", index: 0 } }
    }
    const split = activeSplit(ws)
    if (slot.kind === "replace") {
      const target = at.keys[slot.index]
      if (target === undefined) return null
      const next = dropTab(ws, key, target, "center")
      return next === ws ? null : { next, show: slot }
    }
    const next = insertIntoActive(ws, key, slot.index)
    if (next === ws) return null
    const from = split === null ? -1 : split.views.indexOf(key)
    if (from !== -1) {
      return { next, show: { kind: "move", index: slot.index, from } }
    }
    const landed = entryOf(next, key)
    const fills =
      split === null && isSplit(landed)
        ? (landed.views.find((v) => v !== key) ?? null)
        : null
    return {
      next,
      show: {
        kind: "insert",
        index: slot.index,
        ...insertPreview(at.edges, slot.index),
        fills: fills !== null && !at.keys.includes(fills) ? fills : null,
      },
    }
  }

  function track(event: DragEvent<HTMLDivElement>): boolean {
    if (dragging === null || !event.dataTransfer.types.includes(TAB_MIME)) {
      return false
    }
    geometry.current ??= measure()
    const at = geometry.current
    if (at === null) return false
    const left = area.current?.getBoundingClientRect().left ?? 0
    const full = (activeSplit(ws)?.views.length ?? 0) >= MAX_SPLIT
    const slot = slotAt(event.clientX - left, at.edges, full)
    const id = slot === null ? null : `${slot.kind}:${slot.index}`
    if (id !== under.current.id) {
      // Only a change of slot costs anything: dragover fires constantly.
      const planned = slot === null ? null : plan(dragging, slot, at)
      under.current = { id, next: planned?.next ?? null }
      setPreview(planned?.show ?? null)
    }
    return under.current.next !== null
  }

  function leave() {
    under.current = { id: null, next: null }
    setPreview(null)
  }

  const catcher =
    dragging === null ? null : (
      <div
        data-drop-target=""
        data-drop-slot={
          preview === null ? undefined : `${preview.kind}:${preview.index}`
        }
        className="absolute inset-0 z-40"
        onDragOver={(event) => {
          if (!track(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
        }}
        onDragLeave={(event) => {
          const to = event.relatedTarget
          if (!(to instanceof Node) || !event.currentTarget.contains(to)) {
            leave()
          }
        }}
        onDrop={(event) => {
          const ok = track(event)
          const next = under.current.next
          leave()
          setDrag(null)
          if (!ok || next === null) return
          event.preventDefault()
          setLanding(true)
          setLandings((n) => n + 1)
          notePlaced(next)
          setWs(next)
        }}
      />
    )

  const shifts = new Map<string, number>()
  if (preview?.kind === "insert" && geometry.current !== null) {
    geometry.current.keys.forEach((key, i) =>
      shifts.set(key, preview.shifts[i] ?? 0)
    )
  }

  // ---------------------------------------------------------------- layout

  const slots: Slot[] = members.map((member) => ({ member, ghost: false }))
  for (const { member, at } of [...ghosts].sort((a, b) => a.at - b.at)) {
    if (members.some((m) => m.key === member.key)) continue
    slots.splice(Math.min(at, slots.length), 0, { member, ghost: true })
  }
  const layout = roles(slots.length)
  const count = slots.length
  const maxSize = count === 2 ? "75%" : count === 3 ? "45%" : "35%"

  /** The divider before slot `at`, sliding with its neighbours: with the
   *  one where the gap opens. */
  function separatorShift(at: number): number | "hidden" | undefined {
    if (preview?.kind !== "insert") return undefined
    if (at === preview.index) return "hidden"
    return at < preview.index
      ? preview.shifts[0]
      : preview.shifts[preview.shifts.length - 1]
  }

  const children: ReactNode[] = []
  slots.forEach(({ member, ghost }, index) => {
    const role = layout[index]!
    if (role === "fill" && index > 0) {
      children.push(
        <LineSeparator
          key="sep-start"
          shift={separatorShift(index)}
          landing={landing}
        />
      )
    }
    if (role === "end" || role === "end2") {
      children.push(
        <LineSeparator
          key={`sep-${role}`}
          shift={separatorShift(index)}
          landing={landing}
        />
      )
    }
    const shift = ghost ? undefined : shifts.get(member.key)
    const body = (
      <div
        data-preview-member={ghost ? undefined : member.key}
        style={
          shift === undefined
            ? undefined
            : { transform: `translateX(${shift}px)` }
        }
        className={cn(
          "relative flex h-full min-h-0 w-full min-w-0",
          dragging !== null && "will-change-transform",
          landing ? "transition-none" : SLIDE
        )}
      >
        {ghost ? null : <HostSlot host={hostFor(member.key)} />}
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
        ref={area}
        data-split={members.length > 1 || undefined}
        className="relative flex min-h-0 min-w-0 flex-1"
      >
        <PanelGroup
          key={landings}
          orientation="horizontal"
          reorder={false}
          className="min-h-0 min-w-0 flex-1"
          data-pane-count={members.length}
        >
          {children}
        </PanelGroup>
        {dragging === null ? null : (
          <DropPreview
            preview={preview}
            geometry={geometry.current}
            dragged={look(dragging)}
            fills={
              preview?.kind === "insert" && preview.fills !== null
                ? look(preview.fills)
                : null
            }
          />
        )}
        {catcher}
      </div>
      {members.map((member) =>
        createPortal(renderMember(member.key), hostFor(member.key), member.key)
      )}
    </MotionConfig>
  )
}

/**
 * What a drag over the content draws over the views, taking no pointer: the
 * gap the views slid apart for, holding the dragged view's mark and title on
 * a muted ground inside a dashed hairline; the member a drop would replace,
 * lit as a target with the same label; or, for a member moving inside its
 * split, a line where it would go. The gap stays mounted for the drag, so
 * moving between edges slides it there rather than drawing it anew; it fades
 * in where it first opens.
 */
function DropPreview({
  preview,
  geometry,
  dragged,
  fills,
}: {
  preview: Preview | null
  geometry: Geometry | null
  dragged: ReturnType<ReturnType<typeof useTabLook>>
  fills: ReturnType<ReturnType<typeof useTabLook>> | null
}) {
  const open = preview?.kind === "insert"
  // The gap's last place, kept while it fades out, and whether it was open
  // the render before: one that opens jumps to its place, then slides.
  const [last, setLast] = useState<{ start: number; width: number } | null>(
    null
  )
  const [wasOpen, setWasOpen] = useState(false)
  if (
    open &&
    (last?.start !== preview.gapStart || last.width !== preview.gapWidth)
  ) {
    setLast({ start: preview.gapStart, width: preview.gapWidth })
  }
  if (open !== wasOpen) setWasOpen(open)
  const gap = open ? { start: preview.gapStart, width: preview.gapWidth } : last
  const total =
    geometry === null ? 0 : geometry.edges[geometry.edges.length - 1]!
  const span = (index: number) =>
    geometry === null
      ? null
      : {
          left: geometry.edges[index]!,
          width: geometry.edges[index + 1]! - geometry.edges[index]!,
        }
  const replaced = preview?.kind === "replace" ? span(preview.index) : null
  const moving = preview?.kind === "move" ? span(preview.from) : null
  const rest =
    open && fills !== null
      ? preview.index === 0
        ? { left: preview.gapWidth, width: total - preview.gapWidth }
        : { left: 0, width: total - preview.gapWidth }
      : null

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30"
    >
      {gap === null ? null : (
        <div
          data-drop-gap=""
          style={
            {
              width: gap.width,
              transform: `translateX(${gap.start}px)`,
            } as CSSProperties
          }
          className={cn(
            "absolute inset-y-0 left-0 p-1.5",
            open ? "opacity-100" : "opacity-0",
            open && wasOpen
              ? "transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
              : "transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
            "motion-reduce:transition-none"
          )}
        >
          <Label
            tab={dragged}
            className="bg-muted/40 border-border border border-dashed"
          />
        </div>
      )}
      {rest === null ? null : (
        <Box at={rest}>
          <Label tab={fills!} className="bg-muted ring-border ring-1" />
        </Box>
      )}
      {replaced === null ? null : (
        <Box at={replaced} key={`replace-${preview!.index}`}>
          <Label tab={dragged} className="bg-muted ring-primary/50 ring-2" />
        </Box>
      )}
      {moving === null ||
      preview?.kind !== "move" ||
      geometry === null ? null : (
        <>
          <Box at={moving}>
            <div className="bg-background/50 size-full" />
          </Box>
          <div
            data-drop-line=""
            style={{ left: geometry.edges[preview.index]! - 1 }}
            className="bg-primary absolute inset-y-1.5 w-0.5 rounded-full"
          />
        </>
      )}
    </div>
  )
}

/** A member's place over the views, fading in. */
function Box({
  at,
  children,
}: {
  at: { left: number; width: number }
  children: ReactNode
}) {
  return (
    <div
      style={{ left: at.left, width: at.width }}
      className="animate-in fade-in-0 absolute inset-y-0 p-1.5 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
    >
      {children}
    </div>
  )
}

/** A view's mark and title, centred in its place. */
function Label({
  tab,
  className,
}: {
  tab: ReturnType<ReturnType<typeof useTabLook>>
  className?: string
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex size-full items-center justify-center gap-2 overflow-hidden px-4 text-sm",
        className
      )}
    >
      <TabMark tab={tab} />
      <span className="truncate">{tab.title}</span>
    </div>
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
function LineSeparator({
  shift,
  landing,
}: {
  /** While a drag opens a gap: how far it slides with its neighbours, or
   *  hidden where the gap opens. */
  shift?: number | "hidden"
  landing: boolean
}) {
  return (
    <Separator
      data-slot="panel-separator"
      aria-label="Resize view"
      style={
        shift === "hidden"
          ? { opacity: 0 }
          : shift === undefined
            ? undefined
            : { transform: `translateX(${shift}px)` }
      }
      className={cn(
        "bg-border relative z-10 w-px shrink-0 cursor-col-resize outline-hidden",
        landing
          ? "transition-none"
          : "transition-[color,background-color,transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        "after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']",
        "hover:bg-ring data-crossing:bg-ring data-resizing:bg-ring focus-visible:bg-ring"
      )}
    />
  )
}
