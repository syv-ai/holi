/**
 * `holi docs screenshot` asks where a tab is drawn: the pane body keyed by
 * the tab, once it is on screen and nothing in it is busy, and not while a
 * dialog is open over the window.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { settledRect } from '../settled-rect'

const RECT = { x: 10, y: 20, width: 300, height: 200 }

function body(key: string): HTMLElement {
  const el = document.createElement('div')
  el.dataset.tab = key
  el.getBoundingClientRect = () =>
    ({ ...RECT, top: 20, left: 10, right: 310, bottom: 220, toJSON() {} }) as DOMRect
  ;(el as unknown as { getAnimations: () => Animation[] }).getAnimations = () => []
  document.body.append(el)
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  })
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

test("answers the tab's rect once it has settled", async () => {
  body('Plan.md')
  const answer = settledRect('Plan.md')
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(answer).resolves.toEqual(RECT)
})

test('waits while the tab says it is busy', async () => {
  const el = body('Plan.md')
  el.setAttribute('aria-busy', 'true')
  let settled = false
  const answer = settledRect('Plan.md').then((r) => ((settled = true), r))
  await vi.advanceTimersByTimeAsync(2_000)
  expect(settled).toBe(false)
  el.removeAttribute('aria-busy')
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(answer).resolves.toEqual(RECT)
})

test('refuses while a dialog is open over the window', async () => {
  body('Plan.md')
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.getBoundingClientRect = () =>
    ({ ...RECT, top: 0, left: 0, right: 1, bottom: 1, toJSON() {} }) as DOMRect
  document.body.append(dialog)
  const answer = settledRect('Plan.md')
  const refused = expect(answer).rejects.toThrow(/dialog or menu is open/)
  await vi.advanceTimersByTimeAsync(3_000)
  await refused
})

test('refuses a tab that is not drawn', async () => {
  const answer = settledRect('Missing.md')
  const refused = expect(answer).rejects.toThrow(/did not finish drawing/)
  await vi.advanceTimersByTimeAsync(9_000)
  await refused
})
