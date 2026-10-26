/**
 * The vault as a graph (docs/features/graph.md): every note a dot, every
 * wiki-link between two notes a line. Tasks and memory are drawn with the
 * rest, each in its own colour; hidden files only while the tree shows them.
 *
 * Main builds the graph in one walk per ask (`notes.graph`), with no index
 * kept; this view asks again a moment after the vault's notes last changed,
 * and lays it out once, still, with d3-force in a worker
 * (`lib/graph-layout.ts`). A scroll pans, a pinch or ⌘-scroll zooms, a drag
 * on the background pans. A dot opens its note beside the graph; the note
 * being read is drawn in the theme colour.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { isTaskFilePath, MEMORY_DIR } from '@holi/shared'
import { RefreshCwIcon, WaypointsIcon } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/reui/alert'
import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { boundsOf, layoutGraph, type Point } from '@/lib/graph-layout'
import type { LayoutRequest, LayoutResponse } from '@/lib/graph-layout.worker'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom, showHiddenByVaultAtom, snapshotAtom } from '@/state/vaults'

type Graph = Awaited<ReturnType<typeof trpc.notes.graph.query>>

/** Zoom past which every note is named, not just the lit ones. */
const LABELS_AT = 1.6
const ZOOM = { min: 0.1, max: 6 }
/** Room round the fitted graph, in px. */
const FIT_PAD = 48
/** How long the vault's notes must be still before the graph is asked again. */
const SETTLE_MS = 800
const NO_POINTS: Point[] = []
const NO_NEIGHBOURS = new Set<number>()

/** A kind of dot: what the legend calls it, its fill, and the files it is. */
interface DotKind {
  label: string
  fill: string
  match(path: string): boolean
}

const MEMORY: DotKind = {
  label: 'Memory',
  fill: 'fill-purple-600 dark:fill-purple-400',
  match: (path) => path.startsWith(`${MEMORY_DIR}/`),
}
const TASK: DotKind = {
  label: 'Task',
  fill: 'fill-info',
  match: isTaskFilePath,
}
const NOTE: DotKind = {
  label: 'Note',
  fill: 'fill-muted-foreground',
  match: () => true,
}
/** In the legend's order; the first that matches a path draws it. */
const KINDS: readonly DotKind[] = [NOTE, TASK, MEMORY]

function fillOf(path: string): string {
  if (MEMORY.match(path)) return MEMORY.fill
  if (TASK.match(path)) return TASK.fill
  return NOTE.fill
}

/** A file's name, without its folders or its extension. */
function labelOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/(?<=.)\.[^./]+$/, '')
}

type Scan = { ok: true; graph: Graph } | { ok: false } | null

/**
 * The vault's graph: asked once on open, then again once the notes have been
 * still a moment after a change. `retry` asks again now.
 */
function useGraph(): { scan: Scan; retry: () => void } {
  const remote = useAtomValue(activeRemoteAtom)
  const hidden = useAtomValue(showHiddenByVaultAtom)[remote ?? ''] ?? false
  const docs = useAtomValue(snapshotAtom).docs
  // What the notes are and when each last changed: a new link is one of
  // those changes, so the graph is asked again only then.
  const fingerprint = useMemo(
    () => docs.map((doc) => `${doc.path}\n${doc.updatedAt}`).join('\n'),
    [docs],
  )
  const [scan, setScan] = useState<Scan>(null)
  const [attempt, setAttempt] = useState(0)
  const asked = useRef<string | null>(null)

  useEffect(() => {
    if (remote === null) return
    const scope = `${remote}\n${hidden}`
    // A new vault, or the hidden files shown or not: asked at once, and the
    // last vault's picture is not shown meanwhile.
    const fresh = asked.current !== scope
    if (fresh) setScan(null)
    asked.current = scope
    let live = true
    const timer = window.setTimeout(
      () => {
        trpc.notes.graph.query({ remote, hidden }).then(
          (graph) => live && setScan({ ok: true, graph }),
          () => live && setScan({ ok: false }),
        )
      },
      fresh ? 0 : SETTLE_MS,
    )
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [remote, hidden, fingerprint, attempt])

  const retry = useCallback(() => {
    setScan(null)
    setAttempt((n) => n + 1)
  }, [])
  return { scan, retry }
}

/**
 * Lays each graph out once, off the main thread, seeded from the last
 * layout so a new link moves the picture a little. What it answers is a
 * graph with ITS layout: the previous pair stays up meanwhile.
 */
function useLayout(graph: Graph | null): {
  laid: { graph: Graph; points: Point[] } | null
  failed: boolean
} {
  const [laid, setLaid] = useState<{ graph: Graph; points: Point[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const positions = useRef(new Map<string, Point>())
  const worker = useRef<Worker | null>(null)
  useEffect(() => {
    // Without workers (a test's jsdom) the layout runs on the page.
    if (typeof Worker === 'undefined') return
    const w = new Worker(new URL('../../lib/graph-layout.worker.ts', import.meta.url), {
      type: 'module',
    })
    // A worker that fails to load or throws answers nothing: say so rather
    // than read the vault forever.
    w.onerror = () => setFailed(true)
    worker.current = w
    return () => {
      w.terminate()
      worker.current = null
    }
  }, [])
  // Once per shape, not per answer: an answer is a new object even when
  // nothing in it changed.
  const shape = useMemo(
    () => (graph === null ? '' : JSON.stringify([graph.nodes, graph.edges])),
    [graph],
  )
  useEffect(() => {
    if (graph === null) return
    const land = (points: Point[]) => {
      positions.current = new Map(graph.nodes.map((node, i) => [node, points[i]!]))
      setLaid({ graph, points })
    }
    const w = worker.current
    if (w === null) {
      land(layoutGraph(graph.nodes, graph.edges, positions.current))
      return
    }
    const id = Math.random()
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id === id) land(event.data.points)
    }
    w.addEventListener('message', onMessage)
    const request: LayoutRequest = {
      id,
      nodes: graph.nodes,
      edges: graph.edges,
      previous: [...positions.current],
    }
    w.postMessage(request)
    return () => w.removeEventListener('message', onMessage)
    // `shape` is the graph's identity: an answer that changed nothing keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])
  return { laid, failed }
}

export function GraphView({
  onOpen,
  reading = null,
}: {
  /** Open a note beside the graph. */
  onOpen: (path: string) => void
  /** The note being read beside the graph, drawn in the theme colour. */
  reading?: string | null
}) {
  const { scan, retry } = useGraph()
  const { laid, failed } = useLayout(scan?.ok ? scan.graph : null)
  const points = laid?.points ?? NO_POINTS
  const drawn = laid?.graph ?? null

  const neighbours = useMemo(() => {
    const out = new Map<number, Set<number>>()
    for (const [a, b] of drawn?.edges ?? []) {
      if (!out.has(a)) out.set(a, new Set())
      if (!out.has(b)) out.set(b, new Set())
      out.get(a)!.add(b)
      out.get(b)!.add(a)
    }
    return out
  }, [drawn])

  // Pan and zoom: screen = middle + (x, y) + k * point. The box exists
  // only once there is a picture, so its listeners wait for one.
  const pictured = drawn !== null && drawn.nodes.length > 0
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const fitted = useRef(false)
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [pictured])

  // Fit once the first layout and the box are both known; after that the
  // view is the reader's.
  useEffect(() => {
    if (fitted.current || points.length === 0 || size.w === 0) return
    fitted.current = true
    const b = boundsOf(points)
    const k = Math.min(
      ZOOM.max,
      Math.max(
        ZOOM.min,
        Math.min(
          (size.w - 2 * FIT_PAD) / Math.max(1, b.maxX - b.minX),
          (size.h - 2 * FIT_PAD) / Math.max(1, b.maxY - b.minY),
        ),
      ),
    )
    setView({
      k,
      x: -k * ((b.minX + b.maxX) / 2),
      y: -k * ((b.minY + b.maxY) / 2),
    })
  }, [points, size])

  // Native and not passive, so a pinch zooms the graph rather than the page.
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      setView((v) => {
        if (!event.ctrlKey && !event.metaKey) {
          return { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }
        }
        const k = Math.min(ZOOM.max, Math.max(ZOOM.min, v.k * Math.exp(-event.deltaY * 0.01)))
        // The point under the pointer stays under it.
        const mx = event.clientX - rect.left - rect.width / 2
        const my = event.clientY - rect.top - rect.height / 2
        return {
          k,
          x: mx - ((mx - v.x) / v.k) * k,
          y: my - ((my - v.y) / v.k) * k,
        }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pictured])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('[data-graph-node]')) return
    const el = event.currentTarget
    el.setPointerCapture(event.pointerId)
    let last = { x: event.clientX, y: event.clientY }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - last.x
      const dy = ev.clientY - last.y
      last = { x: ev.clientX, y: ev.clientY }
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const [hover, setHover] = useState<number | null>(null)
  const leave = useCallback((i: number) => setHover((h) => (h === i ? null : h)), [])
  const nodes = drawn?.nodes ?? []
  const readingIndex = reading === null ? -1 : nodes.indexOf(reading)
  // What is lit: the hovered note and its neighbours, else the read one's.
  const centre = hover ?? (readingIndex >= 0 ? readingIndex : null)
  const lit = useMemo(
    () =>
      centre === null ? null : new Set([centre, ...(neighbours.get(centre) ?? NO_NEIGHBOURS)]),
    [centre, neighbours],
  )
  const allNamed = view.k >= LABELS_AT
  const linkCount = drawn?.edges.length ?? 0

  // The layers depend on the graph, its layout and what is lit, never on the
  // view: a pan or zoom changes only the outer transform and `--graph-k`,
  // which keeps strokes and labels their size on screen. Each node is
  // memoised too, so a hover redraws only the nodes whose light changed.
  const edgeLayer = useMemo(
    () =>
      drawn?.edges.map(([a, b]) => (
        <GraphEdge
          key={`${a}-${b}`}
          from={points[a]!}
          to={points[b]!}
          on={a === centre || b === centre}
        />
      )),
    [drawn, points, centre],
  )
  const nodeLayer = useMemo(
    () =>
      drawn?.nodes.map((path, i) => (
        <GraphNode
          key={path}
          path={path}
          fill={fillOf(path)}
          index={i}
          at={points[i]!}
          radius={3 + Math.min(5, Math.sqrt(neighbours.get(i)?.size ?? 0))}
          reading={i === readingIndex}
          dim={lit !== null && !lit.has(i)}
          named={allNamed || (lit !== null && lit.has(i))}
          centre={i === centre}
          onEnter={setHover}
          onLeave={leave}
          onOpen={onOpen}
        />
      )),
    [drawn, points, neighbours, readingIndex, lit, allNamed, centre, leave, onOpen],
  )

  if (failed || scan?.ok === false) {
    return (
      <div className="flex flex-1 items-start justify-center p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>
            {failed ? 'Couldn’t lay out the graph' : 'Couldn’t read the vault’s links'}
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-col items-start gap-2">
              {failed
                ? 'The layout stopped before it finished.'
                : 'Holi could not walk the vault’s notes just now.'}
              <Button variant="outline" size="sm" onClick={retry}>
                <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (drawn === null) {
    return (
      <div role="status" aria-label="Reading the vault" className="flex flex-1 flex-col gap-3 p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="min-h-0 flex-1" />
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <IconStackEmpty
        icon={WaypointsIcon}
        title="No notes to draw yet"
        description="Write a note and link another with [[ ]], and the two show here, joined."
      />
    )
  }

  return (
    <div className="bg-background relative flex h-full min-h-0 flex-1 flex-col" data-graph-view="">
      <p className="text-muted-foreground pointer-events-none absolute top-3 left-4 z-10 text-xs">
        {nodes.length} {nodes.length === 1 ? 'note' : 'notes'} · {linkCount}{' '}
        {linkCount === 1 ? 'link' : 'links'}
        {drawn.total > nodes.length ? ` · the ${nodes.length} best-linked of ${drawn.total}` : null}
      </p>
      <p className="text-muted-foreground pointer-events-none absolute right-4 bottom-3 z-10 flex gap-3 text-xs">
        {KINDS.map((kind) => (
          <span key={kind.label} className="flex items-center gap-1.5">
            <svg viewBox="0 0 8 8" className="size-2" aria-hidden="true">
              <circle cx="4" cy="4" r="4" className={kind.fill} />
            </svg>
            {kind.label}
          </span>
        ))}
      </p>
      <div
        ref={box}
        className="min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
      >
        {size.w > 0 ? (
          <svg
            width={size.w}
            height={size.h}
            className="block select-none"
            aria-label="The vault's notes and their links"
          >
            <g
              transform={`translate(${size.w / 2 + view.x} ${size.h / 2 + view.y}) scale(${view.k})`}
              style={{ '--graph-k': view.k } as React.CSSProperties}
            >
              <g>{edgeLayer}</g>
              {nodeLayer}
            </g>
          </svg>
        ) : null}
      </div>
    </div>
  )
}

/** A line between two notes, a hairline at any zoom. */
const GraphEdge = memo(function GraphEdge({
  from,
  to,
  on,
}: {
  from: Point
  to: Point
  on: boolean
}) {
  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      vectorEffect="non-scaling-stroke"
      className={cn('motion-respond', on ? 'stroke-foreground' : 'stroke-muted-foreground/40')}
    />
  )
})

/** Undo the zoom, so a label reads at the same size at any zoom. */
const LABEL_STYLE = {
  '--label-size': 'calc(12px / var(--graph-k))',
  '--label-shift': 'calc(12px / var(--graph-k))',
} as React.CSSProperties

/** A note: a dot sized by its links, a link to open it beside the graph. */
const GraphNode = memo(function GraphNode({
  path,
  fill,
  index,
  at,
  radius,
  reading,
  dim,
  named,
  centre,
  onEnter,
  onLeave,
  onOpen,
}: {
  path: string
  fill: string
  index: number
  at: Point
  radius: number
  reading: boolean
  dim: boolean
  named: boolean
  centre: boolean
  onEnter: (i: number) => void
  onLeave: (i: number) => void
  onOpen: (path: string) => void
}) {
  return (
    <g
      data-graph-node={path}
      role="link"
      tabIndex={0}
      aria-label={path}
      className={cn('motion-respond cursor-pointer outline-none', dim && 'opacity-40')}
      onPointerEnter={() => onEnter(index)}
      onPointerLeave={() => onLeave(index)}
      // Focus lights a note as hover does: that is its focus treatment.
      onFocus={() => onEnter(index)}
      onBlur={() => onLeave(index)}
      onClick={() => onOpen(path)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(path)
      }}
    >
      <circle
        cx={at.x}
        cy={at.y}
        r={radius + (reading ? 2 : 0)}
        className={reading ? 'fill-primary' : fill}
      />
      {named ? (
        <text
          x={at.x}
          y={at.y + radius}
          textAnchor="middle"
          style={LABEL_STYLE}
          className={cn(
            'translate-y-(--label-shift) text-(length:--label-size)',
            centre ? 'fill-foreground' : 'fill-muted-foreground',
          )}
        >
          {labelOf(path)}
        </text>
      ) : null}
    </g>
  )
})
