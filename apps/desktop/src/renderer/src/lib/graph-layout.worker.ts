/**
 * The graph view's layout, off the main thread: at the node cap it takes about
 * a second, which on the page would freeze the whole window.
 */
import { layoutGraph, type Point } from './graph-layout'

export interface LayoutRequest {
  id: number
  nodes: string[]
  edges: [number, number][]
  previous: [string, Point][]
}

export interface LayoutResponse {
  id: number
  points: Point[]
}

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const { id, nodes, edges, previous } = e.data
  const response: LayoutResponse = { id, points: layoutGraph(nodes, edges, new Map(previous)) }
  self.postMessage(response)
}
