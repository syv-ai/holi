import { createRequire } from 'node:module'
import { afterEach, expect, test, vi } from 'vitest'
import { APP_HINTS_JS } from '../main/bridge-script'

const nonce = 'opaque-document-nonce'
type IsolatedWindow = Window & typeof globalThis
const JSDOM = (
  createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (
      html: string,
      options: { runScripts: 'outside-only'; pretendToBeVisual: true },
    ) => { window: IsolatedWindow }
  }
).JSDOM
let dom: InstanceType<typeof JSDOM> | undefined
let win: (Window & typeof globalThis) | undefined
let parent: Window & typeof globalThis
const boot = () => {
  dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', pretendToBeVisual: true })
  parent = dom.window
  const frame = parent.document.createElement('iframe')
  parent.document.body.append(frame)
  win = frame.contentWindow as unknown as IsolatedWindow
  Object.defineProperty(win, 'PointerEvent', {
    configurable: true,
    value: class extends win!.MouseEvent {},
  })
  win.document.head.innerHTML = `<meta name="holi-app-document-nonce" content="${nonce}">`
  // jsdom does not implement hit testing. Tests below provide deterministic hit targets.
  Object.defineProperty(win.document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) =>
      x < 50
        ? win?.document.querySelector('button')
        : win?.document.querySelector('[role="menuitemcheckbox"]'),
  })
  win.eval(APP_HINTS_JS)
  return win
}
const receive = (data: object, source: MessageEventSource | null = parent) =>
  win!.dispatchEvent(new win!.MessageEvent('message', { data: { nonce, ...data }, source }))
const messages = () => {
  const seen: unknown[] = []
  vi.spyOn(parent, 'postMessage').mockImplementation((data) => {
    seen.push(data)
  })
  return seen
}
const key = (init: KeyboardEventInit, target: EventTarget = win!) => {
  const event = new win!.KeyboardEvent('keydown', {
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  })
  const immediate = vi.spyOn(event, 'stopImmediatePropagation')
  target.dispatchEvent(event)
  return { event, immediate }
}
const tick = () => new Promise<void>((resolve) => win!.setTimeout(resolve, 0))
const frameTick = () => new Promise<void>((resolve) => win!.requestAnimationFrame(() => resolve()))

afterEach(() => {
  dom?.window.close()
  dom = undefined
  win = undefined
  vi.restoreAllMocks()
})

test('only enabled unmodified non-editable f requests hints; active keys are scoped and consumed', () => {
  const guest = boot()
  const sent = messages()
  expect(key({ key: 'f' }).event.defaultPrevented).toBe(false)
  receive({ type: 'holi:vim-app-config', enabled: true })
  expect(key({ key: 'f', ctrlKey: true }).event.defaultPrevented).toBe(false)
  const input = guest.document.createElement('input')
  guest.document.body.append(input)
  input.focus()
  expect(key({ key: 'f' }, input).event.defaultPrevented).toBe(false)
  input.remove()
  const start = key({ key: 'f' })
  expect(start.event.defaultPrevented).toBe(true)
  expect(start.immediate).toHaveBeenCalledOnce()
  expect(sent).toContainEqual(expect.objectContaining({ type: 'request', nonce }))
  receive({ type: 'holi:vim-app-hints', requestId: 'r1' })
  const active = key({ key: 'a' })
  expect(active.event.defaultPrevented).toBe(true)
  expect(sent).toContainEqual(
    expect.objectContaining({ type: 'key', requestId: 'r1', key: 'a', nonce }),
  )
  const modified = key({ key: 'a', ctrlKey: true })
  expect(modified.event.defaultPrevented).toBe(false)
  expect(sent).toContainEqual(
    expect.objectContaining({ type: 'invalidate', requestId: 'r1', nonce }),
  )
})

test('preserves f and active hint keys for open and closed shadow-root editors', () => {
  const guest = boot()
  const sent = messages()
  receive({ type: 'holi:vim-app-config', enabled: true })

  const openHost = guest.document.createElement('div')
  const openRoot = openHost.attachShadow({ mode: 'open' })
  const openInput = guest.document.createElement('input')
  openRoot.append(openInput)
  guest.document.body.append(openHost)
  openInput.focus()
  expect(key({ key: 'f' }, openInput).event.defaultPrevented).toBe(false)
  expect(sent).not.toContainEqual(expect.objectContaining({ type: 'request' }))

  const closedHost = guest.document.createElement('div')
  const closedRoot = closedHost.attachShadow({ mode: 'closed' })
  const closedInput = guest.document.createElement('input')
  closedRoot.append(closedInput)
  guest.document.body.append(closedHost)
  closedInput.focus()
  expect(key({ key: 'f' }, closedInput).event.defaultPrevented).toBe(false)
  expect(sent).not.toContainEqual(expect.objectContaining({ type: 'request' }))

  const outerHost = guest.document.createElement('div')
  const outerRoot = outerHost.attachShadow({ mode: 'open' })
  const innerHost = guest.document.createElement('div')
  const innerRoot = innerHost.attachShadow({ mode: 'closed' })
  const nestedInput = guest.document.createElement('input')
  innerRoot.append(nestedInput)
  outerRoot.append(innerHost)
  guest.document.body.append(outerHost)
  nestedInput.focus()
  expect(key({ key: 'f' }, nestedInput).event.defaultPrevented).toBe(false)
  expect(sent).not.toContainEqual(expect.objectContaining({ type: 'request' }))

  receive({ type: 'holi:vim-app-hints', requestId: 'shadow-editor' })
  const activeKey = key({ key: 'a' }, nestedInput)
  expect(activeKey.event.defaultPrevented).toBe(false)
  expect(sent).toContainEqual(
    expect.objectContaining({ type: 'invalidate', requestId: 'shadow-editor', nonce }),
  )
  expect(sent).not.toContainEqual(expect.objectContaining({ type: 'key' }))
})

test('authenticates source and nonce, discovers clipped visible supported controls within overlay', () => {
  const guest = boot()
  const sent = messages()
  const button = guest.document.createElement('button')
  button.textContent = 'Save'
  const role = guest.document.createElement('div')
  role.setAttribute('role', 'menuitemcheckbox')
  role.textContent = 'Checked option'
  const clipping = guest.document.createElement('div')
  clipping.style.overflowX = 'hidden'
  clipping.append(button)
  const overlay = guest.document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  overlay.append(clipping, role)
  guest.document.body.append(overlay)
  const rect = (el: Element, left: number, top: number, width: number, height: number) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect)
  rect(button, 10, 10, 40, 20)
  rect(clipping, 20, 0, 80, 100)
  rect(role, 60, 10, 30, 20)
  rect(overlay, 0, 0, 100, 100)
  Object.defineProperty(guest, 'innerWidth', { configurable: true, value: 100 })
  Object.defineProperty(guest, 'innerHeight', { configurable: true, value: 100 })
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => (x < 50 ? button : role),
  })
  receive({ type: 'holi:vim-app-config', enabled: true }, null)
  expect(key({ key: 'f' }).event.defaultPrevented).toBe(false)
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'wrong-source' }, null)
  receive({ type: 'holi:vim-app-hints', requestId: 'bad-nonce', nonce: 'wrong' })
  expect(sent).not.toContainEqual(expect.objectContaining({ type: 'targets' }))
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'ok' })
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'targets',
      requestId: 'ok',
      targets: expect.arrayContaining([
        expect.objectContaining({ label: 'Save', x: 35, y: 20 }),
        expect.objectContaining({ label: 'Checked option', x: 75, y: 20 }),
      ]),
    }),
  )
})

test('offscreen overlays do not hide a painted background button', () => {
  const guest = boot()
  const sent = messages()
  const button = guest.document.createElement('button')
  button.textContent = 'Background action'
  const overlay = guest.document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  guest.document.body.append(button, overlay)
  const rect = (el: Element, left: number, top: number, width: number, height: number) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect)
  rect(button, 10, 10, 30, 20)
  rect(overlay, 120, 10, 30, 20)
  Object.defineProperty(guest, 'innerWidth', { configurable: true, value: 100 })
  Object.defineProperty(guest, 'innerHeight', { configurable: true, value: 100 })
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: () => button,
  })
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'offscreen' })
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'targets',
      requestId: 'offscreen',
      targets: expect.arrayContaining([expect.objectContaining({ label: 'Background action' })]),
    }),
  )
})

test('ancestor-clipped overlay does not hide a painted background button', () => {
  const guest = boot()
  const sent = messages()
  const button = guest.document.createElement('button')
  button.textContent = 'Background action'
  const clipper = guest.document.createElement('div')
  clipper.style.overflow = 'hidden'
  clipper.style.overflowX = 'hidden'
  clipper.style.overflowY = 'hidden'
  const overlay = guest.document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  const overlayButton = guest.document.createElement('button')
  overlayButton.textContent = 'Clipped overlay action'
  overlay.append(overlayButton)
  clipper.append(overlay)
  guest.document.body.append(button, clipper)
  const rect = (el: Element, left: number, top: number, width: number, height: number) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect)
  rect(button, 10, 10, 30, 20)
  rect(clipper, 40, 40, 10, 10)
  rect(overlay, 70, 70, 30, 20)
  rect(overlayButton, 75, 75, 20, 20)
  Object.defineProperty(guest, 'innerWidth', { configurable: true, value: 100 })
  Object.defineProperty(guest, 'innerHeight', { configurable: true, value: 100 })
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => (x > 70 && y > 70 ? overlayButton : button),
  })
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'clipped' })
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'targets',
      requestId: 'clipped',
      targets: expect.arrayContaining([expect.objectContaining({ label: 'Background action' })]),
    }),
  )
})

test('painted overlay controls remain reachable', () => {
  const guest = boot()
  const sent = messages()
  const overlay = guest.document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  const button = guest.document.createElement('button')
  button.textContent = 'Overlay action'
  overlay.append(button)
  const outside = guest.document.createElement('button')
  outside.textContent = 'Outside action'
  guest.document.body.append(overlay, outside)
  const rect = (el: Element, left: number, top: number, width: number, height: number) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect)
  rect(overlay, 0, 0, 100, 100)
  rect(button, 10, 10, 30, 20)
  rect(outside, 120, 10, 30, 20)
  Object.defineProperty(guest, 'innerWidth', { configurable: true, value: 200 })
  Object.defineProperty(guest, 'innerHeight', { configurable: true, value: 100 })
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => {
      if (x >= 120 && x <= 150 && y >= 10 && y <= 30) return outside
      if (x >= 10 && x <= 40 && y >= 10 && y <= 30) return button
      return x >= 0 && x <= 100 && y >= 0 && y <= 100 ? overlay : null
    },
  })
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'painted' })
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'targets',
      requestId: 'painted',
      targets: [expect.objectContaining({ label: 'Overlay action' })],
    }),
  )
})

test('deepest equal-z-index overlay wins and excludes background controls', () => {
  const guest = boot()
  const sent = messages()
  const background = guest.document.createElement('button')
  background.textContent = 'Background'
  const dialog = guest.document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const menu = guest.document.createElement('div')
  menu.setAttribute('role', 'menu')
  const item = guest.document.createElement('button')
  item.textContent = 'Nested action'
  menu.append(item)
  dialog.append(menu)
  guest.document.body.append(background, dialog)
  for (const overlay of [dialog, menu]) overlay.style.zIndex = '10'
  const rect = (el: Element, left: number) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left,
      top: 10,
      right: left + 30,
      bottom: 30,
      width: 30,
      height: 20,
      x: left,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect)
  rect(background, 5)
  rect(dialog, 0)
  rect(menu, 0)
  rect(item, 10)
  Object.defineProperty(guest, 'innerWidth', { configurable: true, value: 100 })
  Object.defineProperty(guest, 'innerHeight', { configurable: true, value: 100 })
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: () => item,
  })
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'nested' })
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'targets',
      requestId: 'nested',
      targets: [expect.objectContaining({ label: 'Nested action' })],
    }),
  )
})

test('advertised control must be the nearest control hit; canceled downs still release and click once', () => {
  const guest = boot()
  const sent = messages()
  const outer = guest.document.createElement('div')
  outer.setAttribute('role', 'treeitem')
  outer.textContent = 'Parent item'
  const nested = guest.document.createElement('button')
  nested.textContent = 'Nested button'
  outer.append(nested)
  guest.document.body.append(outer)
  const rect = vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 10,
    right: 50,
    bottom: 30,
    width: 40,
    height: 20,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect)
  vi.spyOn(nested, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 10,
    right: 50,
    bottom: 30,
    width: 40,
    height: 20,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect)
  Object.defineProperty(guest, 'innerWidth', { configurable: true, value: 100 })
  Object.defineProperty(guest, 'innerHeight', { configurable: true, value: 100 })
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: () => nested,
  })
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'identity' })
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'targets',
      requestId: 'identity',
      targets: [expect.objectContaining({ label: 'Nested button' })],
    }),
  )

  const button = guest.document.createElement('button')
  guest.document.body.append(button)
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    left: 60,
    top: 10,
    right: 90,
    bottom: 30,
    width: 30,
    height: 20,
    x: 60,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect)
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: () => button,
  })
  const click = vi.fn()
  button.addEventListener('click', click)
  button.addEventListener('mousedown', (event) => event.preventDefault())
  receive({ type: 'holi:vim-app-hints', requestId: 'activate' })
  const target = (
    sent.find(
      (message) =>
        (message as { requestId?: string }).requestId === 'activate' &&
        (message as { type?: string }).type === 'targets',
    ) as { targets: Array<{ id: string }> }
  ).targets[0]!
  receive({ type: 'activate', requestId: 'activate', targetId: target.id })
  expect(click).toHaveBeenCalledOnce()
  expect(guest.document.activeElement).not.toBe(button)
  rect.mockRestore()
})

test('stale geometry and mutations invalidate only the active request; disabling cancels', async () => {
  const guest = boot()
  const sent = messages()
  const button = guest.document.createElement('button')
  button.textContent = 'Save'
  guest.document.body.append(button)
  const geometry = vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 10,
    right: 50,
    bottom: 30,
    width: 40,
    height: 20,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect)
  Object.defineProperty(guest.document, 'elementFromPoint', {
    configurable: true,
    value: () => button,
  })
  receive({ type: 'holi:vim-app-config', enabled: true })
  receive({ type: 'holi:vim-app-hints', requestId: 'mutation' })
  guest.document.body.append(guest.document.createElement('div'))
  await tick()
  expect(sent).toContainEqual(
    expect.objectContaining({ type: 'invalidate', requestId: 'mutation' }),
  )

  receive({ type: 'holi:vim-app-hints', requestId: 'layout' })
  geometry.mockReturnValue({
    left: 20,
    top: 10,
    right: 60,
    bottom: 30,
    width: 40,
    height: 20,
    x: 20,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect)
  await frameTick()
  expect(sent).toContainEqual(expect.objectContaining({ type: 'invalidate', requestId: 'layout' }))

  receive({ type: 'holi:vim-app-hints', requestId: 'disabled' })
  expect(sent).toContainEqual(expect.objectContaining({ type: 'targets', requestId: 'disabled' }))
  const beforeDisable = sent.length
  receive({ type: 'holi:vim-app-config', enabled: false })
  const cancellation = sent.slice(beforeDisable)
  expect(cancellation).toContainEqual(
    expect.objectContaining({ type: 'invalidate', requestId: 'disabled', nonce }),
  )
  expect(cancellation).not.toContainEqual(expect.objectContaining({ type: 'targets' }))
})
