/**
 * The vault as a graph (`docs/features/graph.md`): every note a dot, every
 * wiki-link between two notes a line. Memory is drawn with the rest, in its
 * own colour; hidden files only while the tree shows them.
 *
 * Main builds the graph in one walk per ask, with no index kept; this view
 * asks again a moment after the vault changes on disk, and lays it out once,
 * still, with d3-force in a worker (`lib/graph-layout.ts`). A scroll pans, a pinch or
 * ⌘-scroll zooms, a drag on the background pans. A dot opens its note beside
 * the graph, and the note being read is drawn in the theme colour.
 */
import { taskClaim, MEMORY_DIR } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pathLabel } from '@/composites/file-icons'
import { cn } from '@/lib/cn'
import { boundsOf, type Point } from '@/lib/graph-layout'
import type { LayoutRequest, LayoutResponse } from '@/lib/graph-layout.worker'
import { trpc } from '@/lib/trpc'
import { useVaultScan } from '@/lib/use-vault-scan'
import { linkFingerprintAtom } from '@/state/links'
import { openBesideAtom, workspaceAtom } from '@/state/panes'
import { activeRemoteAtom, showHiddenByVaultAtom } from '@/state/vaults'

type Graph = Awaited<ReturnType<typeof trpc.notes.graph.query>>

/** Zoom past which every note is named, not just the lit ones. */
const LABELS_AT = 1.6
const ZOOM = { min: 0.1, max: 6 }
/** Room round the fitted graph, in px. */
const FIT_PAD = 48
const NO_POINTS: Point[] = []
const NO_NEIGHBOURS = new Set<number>()

const kindOf = (path: string): 'memory' | 'task' | 'note' =>
  path.startsWith(`${MEMORY_DIR}/`) ? 'memory' : taskClaim.match(path) ? 'task' : 'note'

const FILL = {
  note: 'fill-muted-foreground',
  task: 'fill-task-todo',
  memory: 'fill-graph-memory',
} as const

/** The note being read: the focused pane's, else the one open beside the
 *  graph (where a dot opens it). */
function useReadingNote(): string | null {
  const w = useAtomValue(workspaceAtom)
  const noteOf = (i: number) => {
    const pane = w.panes[i]
    const tab = pane?.tabs[pane.active]
    return tab?.kind === 'note' && tab.path.endsWith('.md') ? tab.path : null
  }
  const own = noteOf(w.active)
  if (own !== null) return own
  for (let i = 0; i < w.panes.length; i++) {
    const note = noteOf(i)
    if (note !== null) return note
  }
  return null
}

export function GraphView({ visible }: { id?: string; visible: boolean }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const hidden = useAtomValue(showHiddenByVaultAtom)[remote ?? ''] ?? false
  const fingerprint = useAtomValue(linkFingerprintAtom)
  const openBeside = useSetAtom(openBesideAtom)
  const reading = useReadingNote()

  // Asked once on open, then again once the vault has been still a moment
  // after a change.
  const scan = useVaultScan(
    visible && remote !== null ? `${remote}\n${hidden}` : null,
    fingerprint,
    () => trpc.notes.graph.query({ remote: remote!, hidden }),
  )
  const graph = scan?.ok ? scan.data : null

  // Laid out in a worker, so a big vault never freezes the window, and only
  // when the graph itself changed (`shape`), seeded from the last layout. What
  // is drawn is a graph with ITS layout: the previous pair stays up meanwhile.
  const [laid, setLaid] = useState<{ graph: Graph; points: Point[] } | null>(null)
  const [layoutFailed, setLayoutFailed] = useState(false)
  const positions = useRef(new Map<string, Point>())
  const worker = useRef<Worker | null>(null)
  useEffect(() => {
    const w = new Worker(new URL('../../lib/graph-layout.worker.ts', import.meta.url), {
      type: 'module',
    })
    // A worker that fails to load or throws answers nothing: say so rather
    // than read the vault forever.
    w.onerror = () => setLayoutFailed(true)
    worker.current = w
    return () => {
      w.terminate()
      worker.current = null
    }
  }, [])
  // Once per answer from main, not per render: the answer is a new object
  // even when nothing in it changed.
  const shape = useMemo(
    () => (graph === null ? '' : JSON.stringify([graph.nodes, graph.edges])),
    [graph],
  )
  useEffect(() => {
    const w = worker.current
    if (graph === null || w === null) return
    const id = Math.random()
    const onMessage = (e: MessageEvent<LayoutResponse>) => {
      if (e.data.id !== id) return
      positions.current = new Map(graph.nodes.map((n, i) => [n, e.data.points[i]!]))
      setLaid({ graph, points: e.data.points })
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
    // `shape` is the graph's identity: a push that changed nothing keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])
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

  // Pan and zoom: screen = middle + (x, y) + k * point.
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const fitted = useRef(false)
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
    setView({ k, x: -k * ((b.minX + b.maxX) / 2), y: -k * ((b.minY + b.maxY) / 2) })
  }, [points, size])

  // Native and not passive, so a pinch zooms the graph rather than the page.
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      setView((v) => {
        if (!e.ctrlKey && !e.metaKey) return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
        const k = Math.min(ZOOM.max, Math.max(ZOOM.min, v.k * Math.exp(-e.deltaY * 0.01)))
        // The point under the pointer stays under it.
        const mx = e.clientX - rect.left - rect.width / 2
        const my = e.clientY - rect.top - rect.height / 2
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-graph-node]')) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let last = { x: e.clientX, y: e.clientY }
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
  // view: a pan or zoom changes only the outer transform and `--graph-k`, which
  // keeps strokes and labels their size on screen. Each node is memoised too,
  // so a hover redraws only the nodes whose light changed.
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
          index={i}
          at={points[i]!}
          radius={3 + Math.min(5, Math.sqrt(neighbours.get(i)?.size ?? 0))}
          reading={i === readingIndex}
          dim={lit !== null && !lit.has(i)}
          named={allNamed || (lit !== null && lit.has(i))}
          centre={i === centre}
          onEnter={setHover}
          onLeave={leave}
          onOpen={openBeside}
        />
      )),
    [drawn, points, neighbours, readingIndex, lit, allNamed, centre, leave, openBeside],
  )

  const error = layoutFailed
    ? 'Couldn’t lay out the graph.'
    : scan !== null && !scan.ok
      ? 'Couldn’t read the vault’s links.'
      : null

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background" data-graph-view="">
      <p
        className="pointer-events-none absolute top-3 left-4 z-10 text-[11px] text-muted-foreground"
        data-graph-error={error === null ? undefined : ''}
      >
        {error ??
          (drawn === null
            ? 'Reading the vault…'
            : `${nodes.length} note${nodes.length === 1 ? '' : 's'} · ${linkCount} link${linkCount === 1 ? '' : 's'}`)}
        {error === null && drawn !== null && drawn.total > nodes.length && (
          <>
            {' '}
            · the {nodes.length} best-linked of {drawn.total}
          </>
        )}
      </p>
      {drawn !== null && (
        <p className="pointer-events-none absolute right-4 bottom-3 z-10 flex gap-3 text-[11px] text-muted-foreground">
          {(['note', 'task', 'memory'] as const).map((kind) => (
            <span key={kind} className="flex items-center gap-1.5">
              <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
                <circle cx="4" cy="4" r="4" className={FILL[kind]} />
              </svg>
              {kind === 'note' ? 'Note' : kind === 'task' ? 'Task' : 'Memory'}
            </span>
          ))}
        </p>
      )}
      <div
        ref={box}
        className="min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
      >
        {size.w > 0 && (
          <svg width={size.w} height={size.h} className="block select-none">
            <g
              transform={`translate(${size.w / 2 + view.x} ${size.h / 2 + view.y}) scale(${view.k})`}
              style={{ '--graph-k': view.k } as React.CSSProperties}
            >
              <g>{edgeLayer}</g>
              {nodeLayer}
            </g>
          </svg>
        )}
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
  fontSize: 'calc(11px / var(--graph-k))',
  transform: 'translateY(calc(12px / var(--graph-k)))',
} as const

/** A note: a dot sized by its links, a link to open it beside the graph. */
const GraphNode = memo(function GraphNode({
  path,
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
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onOpen(path)
      }}
    >
      <circle
        cx={at.x}
        cy={at.y}
        r={radius + (reading ? 2 : 0)}
        className={reading ? 'fill-primary' : FILL[kindOf(path)]}
      />
      {named && (
        <text
          x={at.x}
          y={at.y + radius}
          textAnchor="middle"
          style={LABEL_STYLE}
          className={centre ? 'fill-foreground' : 'fill-muted-foreground'}
        >
          {pathLabel(path)}
        </text>
      )}
    </g>
  )
})
