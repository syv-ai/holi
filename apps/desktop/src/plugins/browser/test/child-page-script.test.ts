import { JSDOM } from 'jsdom'
import { afterEach, expect, it } from 'vitest'
import SCRIPT from '../main/page-script.js?raw'

type ChildPage = {
  vim: {
    armChild(): string
    configure(enabled: boolean, revision: number, nonce: string): boolean
    editingState(): { enabled: boolean; mode: 'insert' | 'normal' }
  }
  hints: { poll(): unknown[] }
}
const worlds: JSDOM[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.window.close()
})

function childWorld() {
  const world = new JSDOM('<!doctype html><input type="text" value="alpha beta">', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  worlds.push(world)
  const { document } = world.window
  const nativeAdd = document.addEventListener.bind(document)
  // Model native trusted key delivery, without simulating browser default
  // typing. Assertions below cover only interception and script-owned motion.
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'keydown' && typeof listener === 'function') {
      nativeAdd(
        type,
        (event) =>
          listener.call(
            document,
            new Proxy(event, {
              get(target, property) {
                if (property === 'isTrusted') return true
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            }),
          ),
        options,
      )
    } else nativeAdd(type, listener, options)
  }) as typeof document.addEventListener
  world.window.eval(SCRIPT)
  const page = world.window.__holiPage as ChildPage
  const key = (value: string, target: Element = document.activeElement!) => {
    const event = new world.window.KeyboardEvent('keydown', {
      key: value,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(event)
    return event
  }
  return { world, document, page, key }
}

it('edits supported child fields without capturing frame-wide hint keys', () => {
  const h = childWorld()
  const field = h.document.querySelector('input')!
  field.focus()
  field.setSelectionRange(0, 0)
  const nonce = h.page.vim.armChild()
  expect(h.page.vim.configure(true, 1, nonce)).toBe(true)
  expect(h.key('Escape').defaultPrevented).toBe(true)
  expect(h.key('w').defaultPrevented).toBe(true)
  expect(field.selectionStart).toBe(6)
  expect(field.value).toBe('alpha beta')
  // Printable keys stay blocked inside field normal mode, not re-routed to hints.
  expect(h.key('f').defaultPrevented).toBe(true)
  expect(h.page.hints.poll()).toEqual([])
  h.document.body.tabIndex = 0
  h.document.body.focus()
  expect(h.key('f').defaultPrevented).toBe(false)
  expect(h.page.hints.poll()).toEqual([])
  const unsupported = h.document.createElement('input')
  unsupported.type = 'email'
  h.document.body.append(unsupported)
  unsupported.focus()
  expect(h.key('Escape').defaultPrevented).toBe(false)
})

it('releases child editing on blur and rejects an earlier document nonce', () => {
  const first = childWorld()
  first.document.querySelector('input')!.focus()
  const oldNonce = first.page.vim.armChild()
  expect(first.page.vim.configure(true, 1, oldNonce)).toBe(true)
  expect(first.key('Escape').defaultPrevented).toBe(true)
  first.world.window.dispatchEvent(new first.world.window.Event('blur'))
  expect(first.page.vim.editingState()).toMatchObject({ enabled: false, mode: 'insert' })
  expect(first.key('x').defaultPrevented).toBe(false)

  const replacement = childWorld()
  replacement.document.querySelector('input')!.focus()
  const nonce = replacement.page.vim.armChild()
  expect(replacement.page.vim.configure(true, 2, oldNonce)).toBe(false)
  expect(replacement.key('Escape').defaultPrevented).toBe(false)
  expect(replacement.page.vim.configure(true, 2, nonce)).toBe(true)
  expect(replacement.key('Escape').defaultPrevented).toBe(true)
})
