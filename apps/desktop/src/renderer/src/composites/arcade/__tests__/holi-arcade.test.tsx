import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@/test/render'
import { HoliArcade } from '../holi-arcade'

const originalIntersectionObserver = globalThis.IntersectionObserver

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  globalThis.IntersectionObserver = originalIntersectionObserver
})

function mount(displayed: boolean) {
  return render(<HoliArcade cast={[]} playing displayed={displayed} onRelease={() => {}} />)
}

test('a hidden launcher arcade does not take keyboard input', () => {
  mount(false)
  const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
  act(() => window.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false)
})

test('a displayed arcade accepts its active game controls', () => {
  mount(true)
  screen.getByRole('application')
  const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
  act(() => window.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
})

test('a parked arcade cancels its frame loop and resumes without scheduling catch-up work', () => {
  globalThis.IntersectionObserver = class {
    readonly root = null
    readonly rootMargin = '0px'
    readonly thresholds = [0]
    constructor(_callback: IntersectionObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  const context = new Proxy(
    {},
    {
      get: () => () => {},
      set: () => true,
    },
  ) as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 480, 320),
  )
  let nextFrame = 0
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++nextFrame)
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const view = mount(true)
  expect(request).toHaveBeenCalledTimes(1)

  view.rerender(<HoliArcade cast={[]} playing={false} displayed={false} onRelease={() => {}} />)
  expect(cancel).toHaveBeenCalledWith(1)
  view.rerender(<HoliArcade cast={[]} playing={false} displayed onRelease={() => {}} />)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenNthCalledWith(2, expect.any(Function))
})

test('hiding a playing arcade never restores focus when it returns', () => {
  const view = mount(true)
  const arcade = screen.getByRole('application')
  expect(document.activeElement).toBe(arcade)
  view.rerender(<HoliArcade cast={[]} playing displayed={false} onRelease={() => {}} />)
  const outside = document.createElement('button')
  document.body.append(outside)
  outside.focus()
  view.rerender(<HoliArcade cast={[]} playing displayed onRelease={() => {}} />)
  expect(document.activeElement).toBe(outside)
  outside.remove()
})
