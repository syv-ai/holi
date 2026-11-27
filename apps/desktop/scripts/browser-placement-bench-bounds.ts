import assert from 'node:assert/strict'
import type { BrowserWindow, WebContentsView } from 'electron'
import { boundsFrameAligned } from './browser-placement-bounds.mjs'
type Box = { x: number; y: number; width: number; height: number }
export async function assertPlacementBounds({
  win,
  expectedViews,
  placementHistory,
  boundsDiagnosticHistory,
  label,
}: {
  win: BrowserWindow
  expectedViews: number
  placementHistory: { at: number; rect: Box | null }[]
  boundsDiagnosticHistory: unknown[]
  label: string
}): Promise<void> {
  const attempts: unknown[] = []
  const diagnosticStartedAt = performance.now()
  for (let frame = 1; frame <= 3; frame++) {
    const observedAt = performance.now()
    const rendererRects = (await win.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => resolve([...document.querySelectorAll('[data-browser-tab] > div:last-child')].map((el) => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } }).filter((r) => r.width >= 1 && r.height >= 1))))",
    )) as { x: number; y: number; width: number; height: number }[]
    const nativeRects = (win.contentView.children as WebContentsView[]).map((view) =>
      view.getBounds(),
    )
    assert.equal(nativeRects.length, expectedViews, `${label}: native view attachment`)
    if (expectedViews === 0) return
    assert.equal(rendererRects.length, nativeRects.length, `${label}: renderer/native bounds count`)
    const zoom = win.webContents.getZoomFactor()
    const expected = rendererRects.map((rect) => ({
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom),
    }))
    const productionRects = placementHistory.flatMap((message) =>
      message.rect === null
        ? []
        : [
            {
              x: Math.round(message.rect.x * zoom),
              y: Math.round(message.rect.y * zoom),
              width: Math.round(message.rect.width * zoom),
              height: Math.round(message.rect.height * zoom),
            },
          ],
    )
    const aligned = boundsFrameAligned(expected, nativeRects, productionRects)
    const matchingProductionPlacementMessages = placementHistory.filter(
      (message) =>
        message.rect !== null &&
        expected.some((rect) =>
          ['x', 'y', 'width', 'height'].every(
            (key) =>
              Math.round(message.rect![key as keyof typeof rect] * zoom) ===
              rect[key as keyof typeof rect],
          ),
        ),
    )
    const diagnosticSample = {
      label,
      hostFrame: frame,
      observedAt,
      expected,
      native: nativeRects,
      aligned,
      matchingProductionPlacementMessages,
    }
    attempts.push(diagnosticSample)
    boundsDiagnosticHistory.push(diagnosticSample)
    if (aligned) {
      boundsDiagnosticHistory.push({
        label,
        alignedAt: performance.now(),
        hostFramesToAlignment: frame,
        latencyMs: performance.now() - diagnosticStartedAt,
      })
      return
    }
  }
  throw new Error(
    `${label}: renderer/native bounds failed to align within 3 host frames: ${JSON.stringify(attempts)}`,
  )
}
