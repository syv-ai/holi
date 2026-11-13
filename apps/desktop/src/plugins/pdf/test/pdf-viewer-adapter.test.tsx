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
  const metrics = { scrollTop: 1453.5, scrollLeft: 20 }
  const scrollTo = vi.fn(({ x, y }: { x: number; y: number }) => {
    metrics.scrollLeft = x
    metrics.scrollTop = y
  })
  let page = 3
  const scrollToPage = vi.fn(({ pageNumber }: { pageNumber: number }) => {
    page = pageNumber
  })
  const scroll = { forDocument: () => ({ getCurrentPage: () => page, scrollToPage }) }
  let resized = () => {}
  let scrolled = () => {}
  const unsubscribe = vi.fn()
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
    getPlugin: (id: string) => ({ provides: () => (id === 'viewport' ? viewport : scroll) }),
    getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'pdf' } }) }),
  })
  return {
    metrics,
    scrollTo,
    scrollToPage,
    resize: () => resized(),
    resetBeforeMove: () => {
      page = 1
      metrics.scrollTop = 0
      metrics.scrollLeft = 0
    },
    searchHitScroll: () => {
      page = 1
      metrics.scrollTop = 0
      scrolled()
    },
    unsubscribe,
  }
}

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

test.each(['pointerdown', 'keydown', 'wheel'])(
  '%s in the PDF cancels pending position restoration',
  async (event) => {
    const viewport = viewportFixture()
    const ref = createRef<PDFViewerRef>()
    const ready = vi.fn()
    render(<PdfViewerAdapter ref={ref} onReady={ready} />)
    await waitFor(() => expect(ready).toHaveBeenCalled())
    const element = ref.current!.container!
    vi.useFakeTimers()
    try {
      act(() => {
        customElements.get('holi-pdf-container')!.prototype.connectedMoveCallback.call(element)
        element.dispatchEvent(new Event(event, { bubbles: true, composed: true }))
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
      expect(viewport.scrollToPage).toHaveBeenLastCalledWith({ pageNumber: 3, behavior: 'instant' })
      expect(viewport.metrics).toEqual({ scrollTop: 1453.5, scrollLeft: 20 })
    }
    expect(viewport.scrollToPage).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    act(() => viewport.searchHitScroll())
    expect(viewport.scrollToPage).toHaveBeenCalledTimes(2)
    expect(viewport.metrics.scrollTop).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
