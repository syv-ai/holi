import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { MotionConfig } from "motion/react"

import {
  Panel,
  PanelGroup,
  PanelSeparator,
} from "@/components/ui/motion-panels"
import type { ShellPane } from "@/state/shell-workspace"

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

  const children: ReactNode[] = []
  slots.forEach(({ pane, ghost }, index) => {
    const role = layout[index]!
    if (role === "fill" && index > 0) {
      children.push(<PanelSeparator key="sep-start" aria-label="Resize pane" />)
    }
    if (role === "end") {
      children.push(<PanelSeparator key="sep-end" aria-label="Resize pane" />)
    }
    const body = ghost ? null : <HostSlot host={hostFor(pane.id)} />
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
      <PanelGroup
        orientation="horizontal"
        reorder={false}
        className="min-h-0 min-w-0 flex-1"
        data-pane-count={panes.length}
      >
        {children}
      </PanelGroup>
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
