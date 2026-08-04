import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

// Radix relies on DOM APIs jsdom omits. Polyfill the ones its Dialog touches,
// or focus-trap/pointer interactions throw instead of exercising real behaviour.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * Park resizable handles far from the origin.
 *
 * `react-resizable-panels` listens for `pointerdown` on the document in the
 * **capture** phase, hit-tests the point against every separator's bounding box,
 * and calls `preventDefault()` when it finds one — that is how a drag starts.
 * jsdom computes no layout, so every box is `0×0` at the origin *and* userEvent
 * dispatches at `(0, 0)`: every click anywhere inside a panel group scores as a
 * hit. Most clicks survive it, because `click` fires regardless — but anything
 * that opens on `pointerdown` does not, so Radix menus inside a group silently
 * stopped opening the moment MailView gained a split.
 *
 * Every rect in jsdom is a fiction; this only picks a more useful one. Real
 * dragging is not testable here either way (it needs measured geometry), so the
 * handles are moved somewhere no test aims at, and clicks reach what they hit.
 */
const HANDLE_ORIGIN = 10_000
const boundingRect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  if (!(this instanceof HTMLElement) || this.dataset.slot !== 'resizable-handle') {
    return boundingRect.call(this)
  }
  const rect = {
    x: HANDLE_ORIGIN,
    y: HANDLE_ORIGIN,
    left: HANDLE_ORIGIN,
    top: HANDLE_ORIGIN,
    right: HANDLE_ORIGIN + 1,
    bottom: HANDLE_ORIGIN + 1,
    width: 1,
    height: 1,
  }
  return { ...rect, toJSON: () => rect } as DOMRect
}
