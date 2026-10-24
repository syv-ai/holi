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
  dropTab,
  MAX_PANES,
  paneOf,
  type DropZone,
  type ShellPane,
} from "@/state/shell-workspace"

import { TAB_MIME, tabDragAtom, zoneAt } from "./use-tab-drag"

/**
 * The main area's panes side by side, on motion-panels (MIT, Valerii
 * Strilets): a horizontal group whose one filling panel takes what the sized
 * panes beside it leave. A group holds one sized panel each side of the
 * filling one, so the layout follows the count:
 *
 * - one pane fills;
 * - two: the first fills, the second is sized at the end;
 * - three: sized, filling, sized.
 *
 * **A pane's content never remounts when the layout changes.** Each pane
 * renders through a portal into a host element of its own, and whichever slot
 * holds the pane now adopts that host, so a session's composer or a document
 * keeps its state as panes come and go around it.
 *
 * **Opening and closing fold.** A pane that arrives in a sized slot mounts
 * folded and opens; one that leaves from a sized slot stays as an empty ghost
 * while it folds away. The filling slot cannot fold, so a pane arriving or
 * leaving there just lands. Under reduced motion the library folds at once.
 *
 * **Split view.** With two or more panes the area is the window's ground and
 * each pane a card on it (docs/features/tabs-panes.md, Split view): rounded,
 * a hairline border, the view's tint (index.css, Glass), the focused one
 * ringed, and the separators in the gaps between them. A card that arrives
 * fades in from a hair smaller as its panel unfolds. One pane keeps the
 * plain look, filling the area. The frame around a slot's host is the same
 * elements either way, only its classes change, so nothing remounts.
 *
 * **Drops.** While a tab is dragged (`use-tab-drag.ts`) each card lays a
 * target over its content, which shows where the tab would go: the half it
 * would split into, or the whole card it would move into.
 */

const MIN_PANE = 240

type Role = "start" | "fill" | "end"

function roles(count: number): Role[] {
  if (count <= 1) return ["fill"]
  if (count === 2) return ["fill", "end"]
  return ["start", "fill", "end"]
}

/** A pane as laid out: the model's, or a ghost folding away. */
type Slot = { pane: ShellPane; ghost: boolean }

function percent(share: number): `${number}%` {
  return `${Math.round(share * 10000) / 100}%`
}

export function PanesView({
  panes,
  renderPane,
  onShareChange,
}: {
  panes: readonly ShellPane[]
  renderPane: (pane: ShellPane) => ReactNode
  /** A sized pane was resized to `share` of the area. */
  onShareChange: (paneId: string, share: number) => void
}) {
  const hosts = useRef(new Map<string, HTMLDivElement>())
  function hostFor(id: string): HTMLDivElement {
    let host = hosts.current.get(id)
    if (host === undefined) {
      host = document.createElement("div")
      host.className = "flex h-full min-h-0 w-full min-w-0 flex-col"
      host.dataset.paneHost = id
      hosts.current.set(id, host)
    }
    return host
  }

  // What was laid out last time, to find the panes that arrive and leave.
  // (React's "adjusting state when a prop changes": set during render.)
  const [before, setBefore] = useState<readonly ShellPane[]>(panes)
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set())
  const [ghosts, setGhosts] = useState<{ pane: ShellPane; at: number }[]>([])
  /** Panes just added, whose cards fade in. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())

  if (before !== panes) {
    setBefore(panes)
    const ids = new Set(panes.map((p) => p.id))
    const old = new Set(before.map((p) => p.id))
    const layoutBefore = roles(before.length)
    const leaving = before
      .map((pane, at) => ({ pane, at }))
      .filter(
        ({ pane, at }) => !ids.has(pane.id) && layoutBefore[at] !== "fill"
      )
    const layoutNow = roles(panes.length + leaving.length)
    const arriving = panes
      .map((pane, at) => ({ pane, at }))
      .filter(({ pane, at }) => !old.has(pane.id) && layoutNow[at] !== "fill")
    if (leaving.length > 0) setGhosts((g) => [...g, ...leaving])
    const added = panes.filter((pane) => !old.has(pane.id))
    if (added.length > 0 && before.length > 0) {
      setFresh((f) => new Set([...f, ...added.map((pane) => pane.id)]))
    }
    if (arriving.length > 0) {
      setEntering(
        (e) => new Set([...e, ...arriving.map(({ pane }) => pane.id)])
      )
    }
  }

  // An arriving pane mounts folded, then opens on the next frame.
  useEffect(() => {
    if (entering.size === 0) return
    const frame = requestAnimationFrame(() => setEntering(new Set()))
    return () => cancelAnimationFrame(frame)
  }, [entering])

  // A card's entrance runs once; after it the class goes.
  useEffect(() => {
    if (fresh.size === 0) return
    const timer = window.setTimeout(() => setFresh(new Set()), 300)
    return () => window.clearTimeout(timer)
  }, [fresh])

  // A ghost goes when its fold ends; a timer stands in should the fold never
  // report (a pane already folded).
  function bury(id: string) {
    setGhosts((g) => g.filter((ghost) => ghost.pane.id !== id))
  }
  useEffect(() => {
    if (ghosts.length === 0) return
    const timer = window.setTimeout(() => setGhosts([]), 600)
    return () => window.clearTimeout(timer)
  }, [ghosts])

  // Hosts of panes that are gone, ghosts included, are let go.
  useEffect(() => {
    const live = new Set([
      ...panes.map((p) => p.id),
      ...ghosts.map((g) => g.pane.id),
    ])
    for (const id of hosts.current.keys()) {
      if (!live.has(id)) hosts.current.delete(id)
    }
  })

  const slots: Slot[] = panes.map((pane) => ({ pane, ghost: false }))
  for (const { pane, at } of [...ghosts].sort((a, b) => a.at - b.at)) {
    slots.splice(Math.min(at, slots.length), 0, { pane, ghost: true })
  }
  const layout = roles(slots.length)
  const count = slots.length
  const maxSize = count === 2 ? "75%" : "45%"
  const split = count > 1
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const dragging = useAtomValue(tabDragAtom)

  const children: ReactNode[] = []
  slots.forEach(({ pane, ghost }, index) => {
    const role = layout[index]!
    if (role === "fill" && index > 0) {
      children.push(<GapSeparator key="sep-start" />)
    }
    if (role === "end") {
      children.push(<GapSeparator key="sep-end" />)
    }
    const body = (
      <PaneCard
        split={split}
        focused={split && !ghost && pane.id === ws.focused}
        enter={fresh.has(pane.id)}
      >
        {ghost ? null : <HostSlot host={hostFor(pane.id)} />}
        {ghost || dragging === null ? null : (
          <DropTarget
            paneId={pane.id}
            dragged={dragging}
            canSplit={ws.panes.length < MAX_PANES}
            own={paneOf(ws, dragging)?.id === pane.id}
            onDrop={(key, zone) => setWs((w) => dropTab(w, key, pane.id, zone))}
            accepts={(key, zone) => dropTab(ws, key, pane.id, zone) !== ws}
          />
        )}
      </PaneCard>
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
          size={percent(pane.share)}
          minSize={MIN_PANE}
          maxSize={maxSize}
          collapsed={ghost || entering.has(pane.id)}
          onFoldEnd={ghost ? () => bury(pane.id) : undefined}
          onSizeChange={(size) => {
            if (!ghost) onShareChange(pane.id, Number.parseFloat(size) / 100)
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
      {/* The ground the cards stand on: padded once there are cards. */}
      <div
        data-split={split || undefined}
        className={cn("flex min-h-0 min-w-0 flex-1", split && "p-1.5")}
      >
        <PanelGroup
          orientation="horizontal"
          reorder={false}
          className="min-h-0 min-w-0 flex-1"
          data-pane-count={panes.length}
        >
          {children}
        </PanelGroup>
      </div>
      {panes.map((pane) =>
        createPortal(renderPane(pane), hostFor(pane.id), pane.id)
      )}
    </MotionConfig>
  )
}

/** Where a pane's host is shown: adopted on mount, given back on unmount. */
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
 * A slot's frame: with several panes a card, its focus ring drawn in the
 * slot's own 2px margin so the panel's clip leaves it whole; with one pane
 * nothing to see.
 */
function PaneCard({
  split,
  focused,
  enter,
  children,
}: {
  split: boolean
  focused: boolean
  enter: boolean
  children: ReactNode
}) {
  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0", split && "p-0.5")}>
      <div
        data-slot={split ? "pane-card" : undefined}
        data-focused={focused || undefined}
        className={cn(
          "relative flex h-full min-h-0 w-full min-w-0",
          split && "bg-background overflow-hidden rounded-xl border",
          focused && "ring-ring/40 ring-1",
          enter &&
            "animate-in fade-in-0 zoom-in-98 motion-reduce:zoom-in-100 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The separator between two cards: the gap itself, showing nothing until
 * the pointer or keyboard focus finds it, then a short pill. It keeps the
 * library's keyboard (arrows, Shift, Home, End) and its double-click reset.
 */
function GapSeparator() {
  return (
    <Separator
      data-slot="panel-separator"
      aria-label="Resize pane"
      className={cn(
        // A 4px gap, with a 12px reach for the pointer.
        "group/gap relative flex w-1 items-center justify-center rounded-full outline-hidden after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "bg-muted-foreground/40 h-8 w-1 rounded-full opacity-0 transition-opacity",
          "group-hover/gap:opacity-100 group-focus-visible/gap:opacity-100 group-data-crossing/gap:opacity-100 group-data-resizing/gap:bg-ring group-data-resizing/gap:opacity-100"
        )}
      />
    </Separator>
  )
}

/**
 * Where a dragged tab would land on this pane, laid over its content while
 * a tab is dragged: the half it would open in, or the whole card it would
 * move into. A drop that would change nothing is refused, so the pointer
 * says so.
 */
function DropTarget({
  paneId,
  dragged,
  own,
  canSplit,
  accepts,
  onDrop,
}: {
  paneId: string
  dragged: string
  own: boolean
  canSplit: boolean
  accepts: (key: string, zone: DropZone) => boolean
  onDrop: (key: string, zone: DropZone) => void
}) {
  const [zone, setZone] = useState<DropZone | null>(null)
  const setDrag = useSetAtom(tabDragAtom)

  function zoneFor(event: DragEvent<HTMLDivElement>): DropZone | null {
    if (!event.dataTransfer.types.includes(TAB_MIME)) return null
    const raw = zoneAt(
      event.clientX,
      event.currentTarget.getBoundingClientRect(),
      own
    )
    const where = canSplit ? raw : "center"
    return accepts(dragged, where) ? where : null
  }

  return (
    <div
      data-drop-target={paneId}
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
      {zone === null ? null : (
        <div
          aria-hidden="true"
          className={cn(
            "bg-primary/15 ring-primary/50 pointer-events-none absolute inset-y-1.5 rounded-lg ring-2",
            zone === "left" && "start-1.5 w-[calc(50%-0.75rem)]",
            zone === "right" && "end-1.5 w-[calc(50%-0.75rem)]",
            zone === "center" && "inset-x-1.5"
          )}
        />
      )}
    </div>
  )
}
