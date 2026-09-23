/**
 * A closing PDF sidebar slides out (`PDF_SIDEBAR_MOTION_CSS`).
 *
 * The viewer unmounts a sidebar in the same render that closes it, so there is
 * no element left to animate, and its sidebar component is not replaceable.
 * What leaves is a stand-in: a copy of the panel as it was, put back where it
 * stood, marked `PDF_SIDEBAR_LEAVING` so the leave animation plays on it, and
 * removed when that ends. It is `inert`: a picture of the panel, which nothing
 * reads or types into. Fed the shadow root's mutation records, from the
 * observer `PdfDocument` already keeps there.
 */
import { PDF_SIDEBAR_LEAVING } from '@/lib/pdf-viewer-config'

/** A sidebar docked beside the pages; the narrow-pane bottom sheet is neither. */
const DOCKED = '[data-sidebar-id]:is(.border-l, .border-r)'

function isDocked(node: Node): node is Element {
  return node instanceof Element && node.matches(DOCKED)
}

function leaving(node: Node): boolean {
  return node instanceof Element && node.classList.contains(PDF_SIDEBAR_LEAVING)
}

export function playSidebarLeaves(records: readonly MutationRecord[]): void {
  for (const record of records) {
    const parent = record.target
    // A sidebar opening where one is still leaving takes its place at once,
    // rather than the two sharing the row for the rest of the leave.
    if ([...record.addedNodes].some((node) => isDocked(node) && !leaving(node))) {
      for (const child of [...parent.childNodes]) if (leaving(child)) (child as Element).remove()
    }
    for (const node of record.removedNodes) {
      if (!isDocked(node) || leaving(node) || !parent.isConnected) continue
      const stand = node.cloneNode(true) as Element
      stand.classList.add(PDF_SIDEBAR_LEAVING)
      stand.setAttribute('inert', '')
      stand.setAttribute('aria-hidden', 'true')
      const next = record.nextSibling?.parentNode === parent ? record.nextSibling : null
      parent.insertBefore(stand, next)
      // No animation (reduced motion, or a runtime without them): gone now.
      const animations = typeof stand.getAnimations === 'function' ? stand.getAnimations() : []
      if (animations.length === 0) {
        stand.remove()
        continue
      }
      const done = () => stand.remove()
      Promise.all(animations.map((animation) => animation.finished)).then(done, done)
    }
  }
}
