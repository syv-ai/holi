import { vi } from 'vitest'

/** jsdom has no layout; control rectangles and hit-testing form the browser seam. */
export function installHintLayout() {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? 'mouse'
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  HTMLElement.prototype.hasPointerCapture ??= () => false
  HTMLElement.prototype.setPointerCapture ??= () => {}
  HTMLElement.prototype.releasePointerCapture ??= () => {}
  const positions = new WeakMap<Element, DOMRect>()
  const place = (element: Element, x = 10, y = 10, width = 100, height = 24) => {
    positions.set(element, new DOMRect(x, y, width, height))
  }
  const controls = () => [
    ...document.querySelectorAll<HTMLElement>('button,a,input,[role],summary,[cmdk-item]'),
  ]
  const rectangle = (element: Element): DOMRect => {
    const explicit = positions.get(element)
    if (explicit) return explicit
    if (element.matches('[role="presentation"],[role="listbox"],[role="menu"],[role="dialog"]'))
      return new DOMRect(0, 0, 1200, 900)
    const index = controls().indexOf(element as HTMLElement)
    if (index >= 0) return new DOMRect(10, 10 + index * 28, 180, 24)
    return new DOMRect(0, 0, 1200, 900)
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectangle(this)
  })
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal('innerHeight', 900)
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn((x: number, y: number) => {
      return (
        [...document.querySelectorAll<HTMLElement>('*')].reverse().find((element) => {
          if (!positions.has(element) && !controls().includes(element)) return false
          if (element.closest('[hidden],[inert],[aria-hidden="true"],[data-host-hints]'))
            return false
          for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
              return false
          }
          const rect = rectangle(element)
          return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
        }) ?? document.body
      )
    }),
  })
  return { place }
}
