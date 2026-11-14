import { createRef } from 'react'
import { act, render, waitFor } from '@/test/render'
import { beforeEach, expect, test, vi } from 'vitest'
import type { PDFViewerRef } from '@embedpdf/react-pdf-viewer'

const lifecycle = vi.hoisted(() => ({
  connected: vi.fn(),
  disconnected: vi.fn(),
  registry: Promise.resolve({ getPlugin: () => null }) as Promise<unknown>,
}))

vi.mock('@embedpdf/react-pdf-viewer', () => ({
  EmbedPdfContainer: class extends HTMLElement {
    config?: unknown
    get registry() {
      return lifecycle.registry
    }
    connectedCallback() {
      lifecycle.connected(this.config)
    }
    disconnectedCallback() {
      lifecycle.disconnected()
    }
  },
}))

import { PdfViewerAdapter } from '../renderer/pdf-viewer-adapter'

beforeEach(() => {
  lifecycle.connected.mockClear()
  lifecycle.disconnected.mockClear()
  lifecycle.registry = Promise.resolve({ getPlugin: () => null })
})

test('initializes the native viewer once, preserves moves, and disposes real removal', async () => {
  const ref = createRef<PDFViewerRef>()
  const onInit = vi.fn()
  const onReady = vi.fn()
  const config = { src: 'blob:disposable-pdf' }
  const mounted = render(
    <PdfViewerAdapter ref={ref} config={config} onInit={onInit} onReady={onReady} />,
  )
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  const element = ref.current!.container!
  expect(lifecycle.connected).toHaveBeenCalledExactlyOnceWith(config)
  expect(onInit).toHaveBeenCalledExactlyOnceWith(element)
  expect(ref.current!.registry).toBe(lifecycle.registry)
  expect(element.isConnected).toBe(true)

  // Chromium captures this callback at registration and invokes it for a
  // connected moveBefore, instead of disconnecting/reconnecting the viewer.
  const definition = customElements.get('holi-pdf-container')!
  expect(definition.prototype.connectedMoveCallback).toBeTypeOf('function')
  definition.prototype.connectedMoveCallback.call(element)
  expect(lifecycle.disconnected).not.toHaveBeenCalled()
  expect(lifecycle.connected).toHaveBeenCalledTimes(1)
  expect(ref.current!.container).toBe(element)

  mounted.unmount()
  expect(element.isConnected).toBe(false)
  expect(lifecycle.disconnected).toHaveBeenCalledTimes(1)
  expect(ref.current).toBeNull()
})

test('a disposed viewer cannot publish a late registry', async () => {
  let settle!: (registry: unknown) => void
  lifecycle.registry = new Promise((resolve) => (settle = resolve))
  const onReady = vi.fn()
  const mounted = render(<PdfViewerAdapter config={{ src: 'blob:old' }} onReady={onReady} />)
  mounted.unmount()
  await act(async () => settle({}))
  expect(onReady).not.toHaveBeenCalled()
  expect(lifecycle.disconnected).toHaveBeenCalledTimes(1)
})

function viewportFixture() {
  const metrics = { scrollTop: 1453.5, scrollLeft: 20, width: 1000, height: 700 }
  const scrollTo = vi.fn(({ x, y }: { x: number; y: number }) => {
    metrics.scrollLeft = x
    metrics.scrollTop = y
    updatePageFromOffset()
  })
  let page = 3
  let scale = 1
  const pageHeight = 500
  const pageGap = 20
  const pageTop = (pageNumber: number) => (pageNumber - 1) * (pageHeight + pageGap) * scale
  const updatePageFromOffset = () => {
    page = Math.max(
      1,
      Math.min(10, Math.floor(metrics.scrollTop / ((pageHeight + pageGap) * scale)) + 1),
    )
  }
  const scrollToPage = vi.fn(({ pageNumber }: { pageNumber: number }) => {
    page = pageNumber
  })
  const getRectPositionForPage = vi.fn(
    (
      pageIndex: number,
      rect: { origin: { x: number; y: number } },
      targetScale = scale,
      rotation = 1,
    ) => ({
      origin: {
        x: (rotation === 0 ? rect.origin.x : pageHeight - rect.origin.y) * targetScale,
        y:
          (pageTop(pageIndex + 1) / scale) * targetScale +
          (rotation === 0 ? rect.origin.y : rect.origin.x) * targetScale,
      },
      size: { width: 0, height: 0 },
    }),
  )
  const scroll = {
    forDocument: () => ({
      getCurrentPage: () => page,
      scrollToPage,
      getMetrics: () => ({
        currentPage: page,
        visiblePages: [page],
        pageVisibilityMetrics: [
          {
            pageNumber: page,
            viewportX: 0,
            viewportY: 0,
            visiblePercentage: 100,
            original: {
              pageX: Math.max(0, metrics.scrollLeft / scale),
              pageY: Math.max(0, (metrics.scrollTop - pageTop(page)) / scale),
              visibleWidth: metrics.width / scale,
              visibleHeight: metrics.height / scale,
              scale: 1,
            },
            scaled: {
              pageX: Math.max(0, metrics.scrollLeft - pageTop(page)),
              pageY: Math.max(0, metrics.scrollTop - pageTop(page)),
              visibleWidth: metrics.width,
              visibleHeight: metrics.height,
              scale,
            },
          },
        ],
        renderedPageIndexes: [page - 1],
        scrollOffset: { x: metrics.scrollLeft, y: metrics.scrollTop },
        startSpacing: 0,
        endSpacing: 0,
      }),
      getRectPositionForPage,
    }),
  }
  let resized = () => {}
  let scrolled = () => {}
  const unsubscribe = vi.fn()
  const zoom = { forDocument: () => ({ getState: () => ({ currentZoomLevel: scale }) }) }
  const viewport = {
    forDocument: () => ({ getMetrics: () => metrics, scrollTo }),
    onScrollChange: (listener: () => void) => {
      scrolled = listener
      return unsubscribe
    },
    onViewportResize: (listener: () => void) => {
      resized = listener
      return unsubscribe
    },
  }
  lifecycle.registry = Promise.resolve({
    getPlugin: (id: string) => ({
      provides: () => ({ viewport, scroll, zoom })[id as 'viewport' | 'scroll' | 'zoom'],
    }),
    getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'pdf' } }) }),
  })
  return {
    metrics,
    scrollTo,
    scrollToPage,
    getRectPositionForPage,
    resize: () => resized(),
    zoomAndResize: (nextScale: number) => {
      scale = nextScale
      // Simulate layout's own approximate scroll adjustment before the adapter
      // settles; preserving the old raw pixels would move this to another page.
      metrics.scrollTop = 2700
      metrics.scrollLeft = 40
      updatePageFromOffset()
      resized()
    },
    setInitialZeroSize: () => {
      metrics.width = 0
      metrics.height = 0
    },
    finishInitialLayout: () => {
      metrics.width = 1000
      metrics.height = 700
    },
    resetBeforeMove: () => {
      page = 1
      metrics.scrollTop = 0
      metrics.scrollLeft = 0
    },
    navigateToNextPage: () => {
      page += 1
      metrics.scrollTop = pageTop(page)
    },
    searchHitScroll: () => {
      page = 1
      metrics.scrollTop = 0
      scrolled()
    },
    unsubscribe,
  }
}

test('does not restore zero-sized startup metrics over the initial fit-width layout', async () => {
  const viewport = viewportFixture()
  viewport.setInitialZeroSize()
  const ready = vi.fn()
  render(<PdfViewerAdapter onReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenCalled())

  act(() => viewport.resize())
  expect(viewport.scrollTo).not.toHaveBeenCalled()
  expect(viewport.scrollToPage).not.toHaveBeenCalled()

  act(() => {
    viewport.finishInitialLayout()
    viewport.resize()
  })
  expect(viewport.scrollTo).not.toHaveBeenCalled()
  expect(viewport.scrollToPage).not.toHaveBeenCalled()
})

test('restores the last reading position when a move resets metrics before its callback', async () => {
  const viewport = viewportFixture()
  const ref = createRef<PDFViewerRef>()
  const ready = vi.fn()
  render(<PdfViewerAdapter ref={ref} onReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenCalled())
  const element = ref.current!.container!
  act(() => {
    // Chromium reports connectedMoveCallback after layout has reset the viewer.
    viewport.resetBeforeMove()
    customElements.get('holi-pdf-container')!.prototype.connectedMoveCallback.call(element)
  })
  await waitFor(() =>
    expect(viewport.scrollTo).toHaveBeenCalledWith({
      x: 20,
      y: 1453.5,
      behavior: 'instant',
    }),
  )
  expect(viewport.scrollToPage).toHaveBeenCalledWith({ pageNumber: 3, behavior: 'instant' })
})

test('restores the reading position after responsive resize without a connected move', async () => {
  const viewport = viewportFixture()
  const ref = createRef<PDFViewerRef>()
  const ready = vi.fn()
  const mounted = render(<PdfViewerAdapter ref={ref} onReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenCalled())
  act(() => {
    // Split layout reuses the host; only a viewport resize is reported.
    viewport.resize()
    // The remounted search sidebar scrolls to its selected hit afterwards.
    viewport.searchHitScroll()
  })
  await waitFor(() =>
    expect(viewport.scrollTo).toHaveBeenCalledWith({
      x: 20,
      y: 1453.5,
      behavior: 'instant',
    }),
  )
  expect(viewport.scrollToPage).toHaveBeenCalledWith({ pageNumber: 3, behavior: 'instant' })
  mounted.unmount()
  expect(viewport.unsubscribe).toHaveBeenCalledTimes(2)
})

test('keeps the same page-relative point when responsive layout changes scale', async () => {
  const viewport = viewportFixture()
  const ready = vi.fn()
  render(<PdfViewerAdapter onReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenCalled())

  act(() => viewport.zoomAndResize(2))
  await waitFor(() => expect(viewport.scrollTo).toHaveBeenCalled())

  // Page 3 starts at 2 * (500 + 20); retain the original 413.5-point
  // in-page offset at the current scale instead of restoring old screen pixels.
  expect(viewport.getRectPositionForPage).toHaveBeenCalledWith(
    2,
    { origin: { x: 20, y: 413.5 }, size: { width: 0, height: 0 } },
    2,
    0,
  )
  expect(viewport.scrollTo).toHaveBeenLastCalledWith({ x: 40, y: 2907, behavior: 'instant' })
  expect(viewport.metrics.scrollTop).toBe(2907)
})

test('keyboard navigation from the outer PDF focus host cancels pending restoration', async () => {
  const viewport = viewportFixture()
  const interactionHost = createRef<HTMLDivElement>()
  const ready = vi.fn()
  const mounted = render(
    <div ref={interactionHost} tabIndex={-1}>
      <PdfViewerAdapter getInteractionHost={() => interactionHost.current} onReady={ready} />
    </div>,
  )
  await waitFor(() => expect(ready).toHaveBeenCalled())
  const outerHost = interactionHost.current!
  outerHost.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'ArrowRight') viewport.navigateToNextPage()
  })
  vi.useFakeTimers()
  try {
    act(() => {
      viewport.resize()
      outerHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(viewport.scrollToPage).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(viewport.scrollToPage).not.toHaveBeenCalled()
    expect(viewport.metrics.scrollTop).toBe(1560)
  } finally {
    vi.useRealTimers()
    mounted.unmount()
  }
})

test('input in a sibling view does not cancel this viewer’s restoration', async () => {
  const viewport = viewportFixture()
  const interactionHost = createRef<HTMLDivElement>()
  const siblingHost = createRef<HTMLDivElement>()
  const ready = vi.fn()
  const mounted = render(
    <div>
      <div ref={interactionHost}>
        <PdfViewerAdapter getInteractionHost={() => interactionHost.current} onReady={ready} />
      </div>
      <div ref={siblingHost} />
    </div>,
  )
  await waitFor(() => expect(ready).toHaveBeenCalled())
  vi.useFakeTimers()
  try {
    act(() => {
      viewport.resize()
      viewport.searchHitScroll()
      siblingHost.current!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(viewport.scrollToPage).toHaveBeenCalledExactlyOnceWith({
      pageNumber: 3,
      behavior: 'instant',
    })
  } finally {
    vi.useRealTimers()
    mounted.unmount()
  }
})

test.each(['pointerdown', 'keydown', 'wheel'])(
  '%s in the PDF cancels pending position restoration',
  async (event) => {
    const viewport = viewportFixture()
    const ref = createRef<PDFViewerRef>()
    const ready = vi.fn()
    render(<PdfViewerAdapter ref={ref} onReady={ready} />)
    await waitFor(() => expect(ready).toHaveBeenCalled())
    const element = ref.current!.container!
    const input = document.createElement('input')
    element.append(input)
    vi.useFakeTimers()
    try {
      act(() => {
        customElements.get('holi-pdf-container')!.prototype.connectedMoveCallback.call(element)
        input.dispatchEvent(new Event(event, { bubbles: true, composed: true }))
        viewport.resize()
      })
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(viewport.scrollTo).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  },
)

test('keeps page and offset through delayed search after resize, then releases the layout guard', async () => {
  const viewport = viewportFixture()
  const ref = createRef<PDFViewerRef>()
  const ready = vi.fn()
  render(<PdfViewerAdapter ref={ref} onReady={ready} />)
  await waitFor(() => expect(ready).toHaveBeenCalled())
  vi.useFakeTimers()
  try {
    act(() => viewport.resize())
    for (let replay = 0; replay < 2; replay++) {
      await act(() => vi.advanceTimersByTimeAsync(300))
      act(() => viewport.searchHitScroll())
      expect(viewport.scrollToPage).not.toHaveBeenCalled()
      expect(viewport.metrics.scrollTop).toBe(0)
    }
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(viewport.scrollToPage).toHaveBeenCalledExactlyOnceWith({
      pageNumber: 3,
      behavior: 'instant',
    })
    expect(viewport.metrics).toMatchObject({ scrollTop: 1453.5, scrollLeft: 20 })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    act(() => viewport.searchHitScroll())
    expect(viewport.scrollToPage).toHaveBeenCalledTimes(1)
    expect(viewport.metrics.scrollTop).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
