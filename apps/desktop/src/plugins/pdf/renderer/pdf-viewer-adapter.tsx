import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import {
  EmbedPdfContainer,
  type PDFViewerProps,
  type PDFViewerRef,
  type PluginRegistry,
  type ScrollCapability,
  type ViewportCapability,
  type ZoomCapability,
} from '@embedpdf/react-pdf-viewer'

/**
 * EmbedPDF's stock element disconnects its Preact tree whenever it is moved.
 * Electron's `moveBefore` preserves this adapter's native viewer by invoking
 * `connectedMoveCallback` instead; ordinary removal keeps the package cleanup.
 */
class HoliPdfContainer extends EmbedPdfContainer {
  afterMove?: () => void

  connectedMoveCallback() {
    this.afterMove?.()
  }
}

const TAG = 'holi-pdf-container'
// Covers EmbedPDF's 300ms search-query rehydration and post-paint effects.
const LAYOUT_QUIET_MS = 400
if (!customElements.get(TAG)) customElements.define(TAG, HoliPdfContainer)

/** Responsive search sidebars re-scroll their selected hit when they remount.
 * Keep the reading position while a resize or pane move settles, unless the person acts. */
function preserveReadingPosition(
  element: HoliPdfContainer,
  registry: PluginRegistry,
  getInteractionHost: () => HTMLElement | null,
): () => void {
  const viewport = registry.getPlugin('viewport')?.provides?.() as ViewportCapability | undefined
  const scroll = registry.getPlugin('scroll')?.provides?.() as ScrollCapability | undefined
  const zoom = registry.getPlugin('zoom')?.provides?.() as ZoomCapability | undefined
  if (viewport === undefined || scroll === undefined || zoom === undefined) return () => {}
  type ReadingPosition = { documentId: string; page: number; x: number; y: number }
  const readPosition = (documentId: string): ReadingPosition => {
    const metrics = viewport.forDocument(documentId).getMetrics()
    const page = scroll.forDocument(documentId).getCurrentPage()
    const scale = zoom.forDocument(documentId).getState().currentZoomLevel
    const visible = scroll
      .forDocument(documentId)
      .getMetrics(metrics)
      .pageVisibilityMetrics.find((item) => item.pageNumber === page)
    return {
      documentId,
      page,
      // Express the viewport's top-left in the visible page's PDF coordinate
      // space. EmbedPDF's layout/zoom owns the conversion back to scroll pixels.
      x: visible === undefined ? 0 : visible.original.pageX - visible.viewportX / scale,
      y: visible === undefined ? 0 : visible.original.pageY - visible.viewportY / scale,
    }
  }
  let lastPosition: ReadingPosition | null = null
  let position: ReadingPosition | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let resizeSuppressionTimer: ReturnType<typeof setTimeout> | undefined
  let suppressResize = false
  const hasLayout = (documentId: string) => {
    const metrics = viewport.forDocument(documentId).getMetrics()
    return metrics.width > 0 && metrics.height > 0
  }
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    position = null
  }
  const restore = () => {
    const target = position
    if (target === null || !element.isConnected) return
    const page = scroll.forDocument(target.documentId)
    const port = viewport.forDocument(target.documentId)
    const metrics = port.getMetrics()
    const pageChanged = page.getCurrentPage() !== target.page
    const scale = zoom.forDocument(target.documentId).getState().currentZoomLevel
    // Rectangle lookup takes a zero-based index. Visibility coordinates already
    // follow the rotated layout, so do not rotate the anchor a second time.
    const anchor = page.getRectPositionForPage(
      target.page - 1,
      { origin: { x: target.x, y: target.y }, size: { width: 0, height: 0 } },
      scale,
      0,
    )
    if (pageChanged) page.scrollToPage({ pageNumber: target.page, behavior: 'instant' })
    if (anchor !== null) {
      const { x, y } = anchor.origin
      if (Math.abs(metrics.scrollLeft - x) > 0.5 || Math.abs(metrics.scrollTop - y) > 0.5) {
        port.scrollTo({ x, y, behavior: 'instant' })
      }
    }
  }
  const settle = () => {
    clearTimeout(timer)
    // Sidebar effects run after paint, and its debounced query can start another
    // smooth scroll. Wait for both viewport resizing and scrolling to go quiet.
    timer = setTimeout(() => {
      timer = undefined
      restore()
      position = null
    }, LAYOUT_QUIET_MS)
  }
  element.afterMove = () => {
    const documentId = registry.getStore().getState().core.activeDocumentId
    if (documentId === null) return
    // moveBefore invokes this after the DOM move, by which point layout may
    // already have reset the viewer's page and viewport metrics.
    position ??= lastPosition ?? readPosition(documentId)
    settle()
  }
  const changed = () => {
    if (position === null) {
      const documentId = registry.getStore().getState().core.activeDocumentId
      if (documentId !== null && hasLayout(documentId)) lastPosition = readPosition(documentId)
      return
    }
    settle()
  }
  const resized = () => {
    if (suppressResize) {
      clearTimeout(resizeSuppressionTimer)
      resizeSuppressionTimer = setTimeout(() => {
        suppressResize = false
        resizeSuppressionTimer = undefined
      }, LAYOUT_QUIET_MS)
      return
    }
    if (position === null) {
      const documentId = registry.getStore().getState().core.activeDocumentId
      if (documentId === null || !hasLayout(documentId)) return
      // The viewer reports zero-sized resize events while opening; those are
      // initialization, not a layout change to undo. Establish a baseline once
      // the viewport has real dimensions, then preserve it across later resizes.
      if (lastPosition === null) {
        lastPosition = readPosition(documentId)
        return
      }
      // A responsive layout can reset the viewer without moving its host.
      // Start from the position recorded before the resize, not the new metrics.
      position = lastPosition
    }
    settle()
  }
  const documentId = registry.getStore().getState().core.activeDocumentId
  if (documentId !== null && hasLayout(documentId)) lastPosition = readPosition(documentId)
  const unsubscribeResize = viewport.onViewportResize(resized)
  const unsubscribeScroll = viewport.onScrollChange(changed)
  // Window capture precedes Holi's document-level PDF shortcut guard.
  const userInput = (event: Event) => {
    const interactionHost = getInteractionHost() ?? element
    if (!event.composedPath().includes(interactionHost)) return
    if (position !== null) {
      suppressResize = true
      clearTimeout(resizeSuppressionTimer)
      resizeSuppressionTimer = setTimeout(() => {
        suppressResize = false
        resizeSuppressionTimer = undefined
      }, LAYOUT_QUIET_MS)
    }
    cancel()
  }
  for (const event of ['pointerdown', 'keydown', 'wheel'])
    window.addEventListener(event, userInput, true)
  return () => {
    cancel()
    clearTimeout(resizeSuppressionTimer)
    element.afterMove = undefined
    unsubscribeResize()
    unsubscribeScroll()
    for (const event of ['pointerdown', 'keydown', 'wheel'])
      window.removeEventListener(event, userInput, true)
  }
}

/** Keeps EmbedPDF's viewer alive when Holi parks and reattaches a PDF pane. */
type PdfViewerAdapterProps = PDFViewerProps & {
  /** The view that owns keyboard dispatch; defaults to the viewer element. */
  getInteractionHost?: () => HTMLElement | null
}

export const PdfViewerAdapter = forwardRef<PDFViewerRef, PdfViewerAdapterProps>(
  function PdfViewerAdapter(
    { config = {}, className, style, onInit, onReady, getInteractionHost },
    ref,
  ) {
    const holderRef = useRef<HTMLDivElement>(null)
    const elementRef = useRef<HoliPdfContainer | null>(null)
    useImperativeHandle(ref, () => ({
      get container() {
        return elementRef.current
      },
      get registry() {
        return elementRef.current?.registry ?? null
      },
    }))

    useEffect(() => {
      const holder = holderRef.current
      if (!holder) return
      const element = document.createElement(TAG) as HoliPdfContainer & {
        config: typeof config
      }
      element.config = config
      elementRef.current = element
      holder.append(element)
      onInit?.(element)
      let live = true
      let releasePosition: (() => void) | undefined
      const registry = element.registry
      void registry.then((ready) => {
        if (!live) return
        releasePosition = preserveReadingPosition(
          element,
          ready,
          getInteractionHost ?? (() => element),
        )
        onReady?.(ready)
      })
      return () => {
        live = false
        releasePosition?.()
        element.remove()
        elementRef.current = null
      }
      // The stock wrapper initializes once. PdfDocument keys this adapter by src.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return <div ref={holderRef} className={className} style={style} />
  },
)
