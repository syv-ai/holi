import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import {
  EmbedPdfContainer,
  type PDFViewerProps,
  type PDFViewerRef,
  type PluginRegistry,
  type ScrollCapability,
  type ViewportCapability,
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
function preserveReadingPosition(element: HoliPdfContainer, registry: PluginRegistry): () => void {
  const viewport = registry.getPlugin('viewport')?.provides?.() as ViewportCapability | undefined
  const scroll = registry.getPlugin('scroll')?.provides?.() as ScrollCapability | undefined
  if (viewport === undefined || scroll === undefined) return () => {}
  type ReadingPosition = { documentId: string; page: number; x: number; y: number }
  const readPosition = (documentId: string): ReadingPosition => {
    const metrics = viewport.forDocument(documentId).getMetrics()
    return {
      documentId,
      page: scroll.forDocument(documentId).getCurrentPage(),
      x: metrics.scrollLeft,
      y: metrics.scrollTop,
    }
  }
  let lastPosition: ReadingPosition | null = null
  let position: ReadingPosition | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let resizeSuppressionTimer: ReturnType<typeof setTimeout> | undefined
  let suppressResize = false
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
    if (pageChanged) page.scrollToPage({ pageNumber: target.page, behavior: 'instant' })
    if (
      pageChanged ||
      Math.abs(metrics.scrollLeft - target.x) > 0.5 ||
      Math.abs(metrics.scrollTop - target.y) > 0.5
    ) {
      port.scrollTo({ x: target.x, y: target.y, behavior: 'instant' })
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
    const metrics = viewport.forDocument(documentId).getMetrics()
    // moveBefore invokes this after the DOM move, by which point layout may
    // already have reset the viewer's page and viewport metrics.
    position ??= lastPosition ?? {
      documentId,
      page: scroll.forDocument(documentId).getCurrentPage(),
      x: metrics.scrollLeft,
      y: metrics.scrollTop,
    }
    settle()
  }
  const changed = () => {
    if (position === null) {
      const documentId = registry.getStore().getState().core.activeDocumentId
      if (documentId !== null) lastPosition = readPosition(documentId)
      return
    }
    restore()
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
      if (documentId === null) return
      // A responsive layout can reset the viewer without moving its host.
      // Start from the position recorded before the resize, not the new metrics.
      position = lastPosition ?? readPosition(documentId)
    }
    restore()
    settle()
  }
  const documentId = registry.getStore().getState().core.activeDocumentId
  if (documentId !== null) lastPosition = readPosition(documentId)
  const unsubscribeResize = viewport.onViewportResize(resized)
  const unsubscribeScroll = viewport.onScrollChange(changed)
  // Window capture precedes Holi's document-level PDF shortcut guard.
  const userInput = (event: Event) => {
    if (!event.composedPath().includes(element)) return
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
export const PdfViewerAdapter = forwardRef<PDFViewerRef, PDFViewerProps>(function PdfViewerAdapter(
  { config = {}, className, style, onInit, onReady },
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
      releasePosition = preserveReadingPosition(element, ready)
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
})
