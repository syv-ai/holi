/**
 * Where a CodeMirror widget and React meet, and the only place they do.
 *
 * The frontmatter block draws React controls, but a widget is plain DOM built
 * in `toDOM`. So the widget publishes a container here and React fills it
 * through a portal from the app's one root (`main.tsx`). A second root per
 * widget would have its own scheduler and no access to the app's providers.
 *
 * The store is tiny and framework-free because the editor layer imports it and
 * must not depend on React.
 */

/** One live frontmatter block, waiting to be drawn into. */
export interface FrontmatterPortal {
  /** Stable for the life of the widget's DOM; the React key. */
  readonly id: number
  /** The empty element inside the widget, portalled into. */
  readonly el: HTMLElement
  /** The file, so the fields know which schema they are drawing. */
  readonly path: string
  /** The YAML between the fences, as the document currently has it. */
  readonly yaml: string
  /** Hand back the whole YAML body; the widget writes it into the document. */
  readonly write: (yaml: string) => void
}

let nextId = 1
const portals = new Map<number, FrontmatterPortal>()
const listeners = new Set<() => void>()

/** Cached so `useSyncExternalStore` sees a stable reference between changes:
 *  rebuilding the array per read is an infinite render loop. */
let snapshot: readonly FrontmatterPortal[] = []

function publish(): void {
  snapshot = [...portals.values()]
  for (const listener of listeners) listener()
}

/** Register a container. Returns the id the widget uses to update and remove it. */
export function openFrontmatterPortal(portal: Omit<FrontmatterPortal, 'id'>): number {
  const id = nextId++
  portals.set(id, { ...portal, id })
  publish()
  return id
}

/**
 * Replace what a live portal is showing, without remounting it. The widget's
 * write-back maps rather than rebuilds, so the fields must re-render from here
 * or keep showing the old value.
 */
export function updateFrontmatterPortal(id: number, yaml: string): void {
  const portal = portals.get(id)
  if (portal === undefined || portal.yaml === yaml) return
  portals.set(id, { ...portal, yaml })
  publish()
}

export function closeFrontmatterPortal(id: number): void {
  if (!portals.delete(id)) return
  publish()
}

export function subscribeFrontmatterPortals(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function frontmatterPortals(): readonly FrontmatterPortal[] {
  return snapshot
}
