/**
 * Where each note of the graph view sits (`docs/features/graph.md`), by a
 * d3-force layout run to rest in one go: the view draws a still picture, so
 * nothing settles on screen, and a graph of a vault is laid out once per
 * change rather than once per frame.
 *
 * `previous` seeds a note's position from the last layout, so a note added or
 * a link written moves the picture a little rather than reshuffling it.
 */
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force'

export interface Point {
  x: number
  y: number
}

/** d3's default cooling, run to `alphaMin`: about 300 ticks. */
const TICKS = 300

export function layoutGraph(
  nodes: readonly string[],
  edges: readonly (readonly [number, number])[],
  previous: ReadonlyMap<string, Point> = new Map(),
): Point[] {
  const data: SimulationNodeDatum[] = nodes.map((path) => {
    const at = previous.get(path)
    return at === undefined ? {} : { x: at.x, y: at.y }
  })
  const simulation = forceSimulation(data)
    .force('link', forceLink(edges.map(([source, target]) => ({ source, target }))).distance(36))
    .force('charge', forceManyBody().strength(-48).distanceMax(400))
    // A gentle pull to the middle keeps notes with no links from drifting off.
    .force('x', forceX(0).strength(0.06))
    .force('y', forceY(0).strength(0.06))
    .stop()
  simulation.tick(TICKS)
  return data.map((d) => ({ x: d.x ?? 0, y: d.y ?? 0 }))
}

/** The box around every point, or a unit box round the origin when there are
 *  none. */
export function boundsOf(points: readonly Point[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (points.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY }
}
