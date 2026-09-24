/**
 * Where a CodeMirror widget and React meet, and the only place they do.
 *
 * The frontmatter block draws real controls — the `DateTimePicker`, a `Select`,
 * a chip field — and those are React components in `primitives/` and
 * `composites/`. A widget is plain DOM built in `toDOM`, the way every other
 * widget in this editor and the table widget itself are built. Neither side can
 * simply call the other.
 *
 * So the widget publishes a **container** here and React fills it through a
 * portal from the app's existing root. There is still exactly one React root in
 * this renderer (`main.tsx`), which is the property worth protecting: a second
 * root per open widget would mean its own scheduler, its own context tree, and
 * no access to any provider the app is wrapped in.
 *
 * The store is deliberately tiny and framework-free — a map, a version counter,
 * and a listener set — because it is imported by the editor layer, which must
 * stay testable without a DOM and must not depend on React.
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

/** Cached so `useSyncExternalStore` sees a stable reference between changes —
 *  rebuilding the array per read is an infinite render loop, not a slow one. */
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
 * Replace what a live portal is showing, without remounting it.
 *
 * The widget's own write-back maps the decoration rather than rebuilding it, so
 * the container survives — and the fields must then re-render from the document
 * they just changed, or the row you edited would keep showing the old value
 * until something unrelated forced a rebuild.
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
