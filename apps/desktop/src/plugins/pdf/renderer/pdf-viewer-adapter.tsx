import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import {
  EmbedPdfContainer,
  type PDFViewerProps,
  type PDFViewerRef,
} from '@embedpdf/react-pdf-viewer'

/**
 * EmbedPDF's stock element disconnects its Preact tree whenever it is moved.
 * Electron's `moveBefore` preserves this adapter's native viewer by invoking
 * `connectedMoveCallback` instead; ordinary removal keeps the package cleanup.
 */
class HoliPdfContainer extends EmbedPdfContainer {
  connectedMoveCallback() {}
}

const TAG = 'holi-pdf-container'
if (!customElements.get(TAG)) customElements.define(TAG, HoliPdfContainer)

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
    const registry = element.registry
    void registry?.then((ready) => {
      if (live) onReady?.(ready)
    })
    return () => {
      live = false
      element.remove()
      elementRef.current = null
    }
    // The stock wrapper initializes once. PdfDocument keys this adapter by src.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={holderRef} className={className} style={style} />
})
