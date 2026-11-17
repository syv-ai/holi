/**
 * What main runs in a page to read it (docs/features/browser.md, The agent):
 * the page as text in reading order, each control numbered, hidden things
 * left out, and the numbers finding their elements again.
 */
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import SCRIPT from '../main/page-script.js?raw'

interface HoliPage {
  read(max: number): { title: string; url: string; text: string; truncated: boolean }
  point(ref: number): { x: number; y: number; lands: boolean } | null
  click(ref: number): boolean
  focus(ref: number): boolean
  valueOf(ref: number): string | null
  fill(ref: number, text: string): boolean
  hints: {
    discover(request: number): { id: string; label: string; x: number; y: number }[] | null
    present(request: number, revision: number, labels: { id: string; key: string }[]): boolean
    clear(request: number): boolean
    activate(request: number, id: string): { x: number; y: number; field: boolean } | null
  }
  vim: {
    documentNonce(): string
    rearm(): string
    configure(enabled: boolean, revision: number, nonce: string): boolean
    mode(): { revision: number; mode: 'insert' | 'normal' }
  }
}

const holi = (): HoliPage => (globalThis as unknown as { __holiPage: HoliPage }).__holiPage

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  document.elementFromPoint = vi.fn(() => null)
  new Function(SCRIPT)()
})

beforeEach(() => {
  document.title = 'Sign in — Example'
  document.body.innerHTML = `
    <header><nav><a href="/pricing">Pricing</a> <a href="https://other.example/x">Elsewhere</a></nav></header>
    <main>
      <h1>Welcome back</h1>
      <p>Sign in to   your account.</p>
      <ul><li>Fast</li><li>Private</li></ul>
      <form>
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@company.com" />
        <input type="password" aria-label="Password" value="hunter2" />
        <label><input type="checkbox" /> Remember me</label>
        <select aria-label="Country"><option>Denmark</option><option>Sweden</option></select>
        <button type="submit">Sign in</button>
      </form>
      <div style="display: none"><button>Hidden button</button></div>
      <p hidden>Secret text</p>
      <script>var x = 1</script>
    </main>`
})

test('reads the page in order, its controls numbered', () => {
  const page = holi().read(12_000)
  expect(page.title).toBe('Sign in — Example')
  expect(page.truncated).toBe(false)
  expect(page.text.split('\n')).toEqual([
    '[1] link "Pricing" → /pricing [2] link "Elsewhere" → https://other.example/x',
    '# Welcome back',
    'Sign in to your account.',
    '- Fast',
    '- Private',
    'Email [3] textbox "Email" (email) placeholder="you@company.com" [4] textbox "Password" (password) [5] checkbox "Remember me" (not checked) Remember me [6] select "Country" value="Denmark" options="Denmark | Sweden" [7] button "Sign in"',
  ])
})

test('leaves out what is hidden, scripts, and a password', () => {
  const { text } = holi().read(12_000)
  expect(text).not.toContain('Hidden button')
  expect(text).not.toContain('Secret text')
  expect(text).not.toContain('var x')
  expect(text).not.toContain('hunter2')
})

test('stops at the limit and says so', () => {
  const page = holi().read(40)
  expect(page.truncated).toBe(true)
  expect(page.text.length).toBeLessThanOrEqual(40)
})

test('a number finds its control until it leaves the page', () => {
  holi().read(12_000)
  const button = document.querySelector('button[type=submit]')!
  const clicked = vi.fn((e: Event) => e.preventDefault())
  button.addEventListener('click', clicked)
  expect(holi().click(7)).toBe(true)
  expect(clicked).toHaveBeenCalled()
  button.remove()
  expect(holi().click(7)).toBe(false)
  expect(holi().point(7)).toBeNull()
})

test('visible hint targets are separate from CLI refs and activation rechecks geometry', () => {
  const button = document.querySelector('button[type=submit]')!
  button.getBoundingClientRect = () =>
    ({
      x: 10,
      y: 20,
      width: 40,
      height: 20,
      left: 10,
      top: 20,
      right: 50,
      bottom: 40,
      toJSON: () => ({}),
    }) as DOMRect
  document.elementFromPoint = vi.fn(() => button)
  holi().read(12_000)
  const targets = holi().hints.discover(1)!
  expect(targets).toHaveLength(1)
  expect(targets[0]?.label).toBe('Sign in')
  expect(holi().hints.present(1, 1, [{ id: targets[0]!.id, key: 'A' }])).toBe(true)
  expect(holi().hints.activate(1, targets[0]!.id)).toEqual({ x: 30, y: 30, field: false })
  expect(holi().hints.clear(1)).toBe(true)
  expect(holi().hints.activate(1, targets[0]!.id)).toBeNull()
})

test('vim mode uses native selections and blocks unsupported edits synchronously', () => {
  const textarea = document.createElement('textarea')
  textarea.value = 'one two\n  three'
  document.body.append(textarea)
  textarea.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 1, nonce)).toBe(true)
  expect(holi().vim.mode()).toEqual({ revision: 1, mode: 'insert' })
  const key = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    })
    textarea.dispatchEvent(event)
    return event
  }
  expect(key('Escape').defaultPrevented).toBe(true)
  expect(holi().vim.mode().mode).toBe('normal')
  textarea.setSelectionRange(0, 0)
  key('w')
  expect(textarea.selectionStart).toBe(4)
  const before = textarea.value
  expect(key('Backspace').defaultPrevented).toBe(true)
  expect(textarea.value).toBe(before)
  expect(key('Tab').defaultPrevented).toBe(false)
  for (const selectionKey of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    expect(key(selectionKey, { shiftKey: true }).defaultPrevented).toBe(false)
  }
  key('a')
  expect(holi().vim.mode().mode).toBe('insert')
  expect(key('x').defaultPrevented).toBe(false)
  expect(holi().vim.configure(false, 2, nonce)).toBe(true)
  expect(holi().vim.configure(true, 1, nonce)).toBe(false)
  expect(holi().vim.mode()).toEqual({ revision: 2, mode: 'insert' })
})

test('moves by grapheme, Unicode word, and logical textarea line without editing', () => {
  const textarea = document.createElement('textarea')
  textarea.value = '  café🙂 x\nlonger'
  document.body.append(textarea)
  textarea.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 10, nonce)).toBe(true)
  const key = (value: string) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)
    return event
  }
  key('Escape')
  textarea.setSelectionRange(6, 6)
  key('l')
  expect(textarea.selectionStart).toBe(8)
  key('h')
  expect(textarea.selectionStart).toBe(6)
  key('^')
  expect(textarea.selectionStart).toBe(2)
  key('w')
  expect(textarea.selectionStart).toBe(9)
  key('b')
  expect(textarea.selectionStart).toBe(2)
  key('w')
  expect(textarea.selectionStart).toBe(9)
  key('e')
  expect(textarea.selectionStart).toBe(16)
  textarea.setSelectionRange(9, 9)
  key('j')
  expect(textarea.selectionStart).toBe(17)
  key('k')
  expect(textarea.selectionStart).toBe(9)
  key('I')
  expect(textarea.selectionStart).toBe(2)
  expect(holi().vim.mode().mode).toBe('insert')
  expect(textarea.value).toBe('  café🙂 x\nlonger')
})

test('e advances strictly beyond the caret across Unicode word ends', () => {
  const textarea = document.createElement('textarea')
  textarea.value = 'cafe\u0301🙂, déjà vu!'
  document.body.append(textarea)
  textarea.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 11, nonce)).toBe(true)
  const key = () =>
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  key()
  textarea.setSelectionRange(0, 0)
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }),
  )
  expect(textarea.selectionStart).toBe(3)
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }),
  )
  expect(textarea.selectionStart).toBe(12)
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }),
  )
  expect(textarea.selectionStart).toBe(15)
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }),
  )
  expect(textarea.selectionStart).toBe(15)
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }),
  )
  expect(textarea.selectionStart).toBe(15)
})

test('line motions include the empty first line before a leading newline', () => {
  const textarea = document.createElement('textarea')
  textarea.value = '\n  café\n🙂'
  document.body.append(textarea)
  textarea.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 12, nonce)).toBe(true)
  const key = (value: string) =>
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    )
  key('Escape')
  textarea.setSelectionRange(1, 1)
  key('k')
  expect(textarea.selectionStart).toBe(0)
  key('0')
  expect(textarea.selectionStart).toBe(0)
  key('^')
  expect(textarea.selectionStart).toBe(0)
  key('I')
  expect(textarea.selectionStart).toBe(0)
  expect(textarea.value).toBe('\n  café\n🙂')
})

test('normal Escape is consumed so native search inputs do not clear', () => {
  const search = document.createElement('input')
  search.type = 'search'
  search.value = 'query'
  document.body.append(search)
  search.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 13, nonce)).toBe(true)
  const press = () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    search.dispatchEvent(event)
    return event
  }
  expect(press().defaultPrevented).toBe(true)
  expect(holi().vim.mode().mode).toBe('normal')
  expect(press().defaultPrevented).toBe(true)
  expect(search.value).toBe('query')
})

test('blur, replacement focus, IME and modified shortcuts keep native ownership', () => {
  const first = document.createElement('textarea')
  const second = document.createElement('textarea')
  first.value = 'first'
  second.value = 'second'
  document.body.append(first, second)
  first.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 20, nonce)).toBe(true)
  const key = (field: HTMLTextAreaElement, value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    })
    field.dispatchEvent(event)
    return event
  }
  key(first, 'Escape')
  expect(holi().vim.mode().mode).toBe('normal')
  first.blur()
  expect(holi().vim.mode().mode).toBe('insert')
  second.focus()
  expect(key(second, 'Escape', { isComposing: true }).defaultPrevented).toBe(false)
  expect(key(second, 'z', { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(holi().vim.mode().mode).toBe('insert')
  expect(holi().vim.configure(false, 21, nonce)).toBe(true)
  expect(key(second, 'Escape').defaultPrevented).toBe(false)
})

test('rejects stale document configuration and leaves unsupported fields native', () => {
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 11, 'stale-document')).toBe(false)
  const password = document.createElement('input')
  password.type = 'password'
  document.body.append(password)
  password.focus()
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  password.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(holi().vim.configure(true, 22, nonce)).toBe(true)
})

test('rearming a surviving document rotates ownership and returns Vim to insert mode', () => {
  const textarea = document.createElement('textarea')
  document.body.append(textarea)
  textarea.focus()
  const previousNonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 30, previousNonce)).toBe(true)
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
  expect(holi().vim.mode().mode).toBe('normal')
  const nonce = holi().vim.rearm()
  expect(nonce).not.toBe(previousNonce)
  expect(holi().vim.mode().mode).toBe('insert')
  expect(holi().vim.configure(false, 31, previousNonce)).toBe(false)
  expect(holi().vim.configure(true, 31, nonce)).toBe(true)
})

test('plaintext-only single-line hosts use native selection for Vim motions', () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'plaintext-only')
  host.setAttribute('tabindex', '0')
  host.setAttribute('aria-label', 'plain')
  host.append(document.createTextNode('café'), document.createTextNode('🙂 two'))
  document.body.append(host)
  host.focus()
  const initialRange = document.createRange()
  initialRange.setStart(host.firstChild!, 0)
  initialRange.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(initialRange)
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 40, nonce)
  const key = (value: string) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  expect(key('Escape').defaultPrevented).toBe(true)
  const range = document.createRange()
  range.setStart(host.firstChild!, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  key('w')
  expect(getSelection()!.anchorNode).toBe(host.lastChild)
  expect(getSelection()!.anchorOffset).toBe(3)
  expect(host.textContent).toBe('café🙂 two')
})

test('plaintext-only i collapses a normal-mode selection before native insertion', () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'plaintext-only')
  host.setAttribute('tabindex', '0')
  host.textContent = 'alpha beta'
  document.body.append(host)
  host.focus()
  const range = document.createRange()
  range.setStart(host.firstChild!, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  holi().vim.configure(true, 48, holi().vim.documentNonce())
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  press('Escape')
  range.setEnd(host.firstChild!, 5)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  expect(getSelection()!.isCollapsed).toBe(false)
  expect(press('i').defaultPrevented).toBe(true)
  expect(getSelection()!.isCollapsed).toBe(true)
  expect(getSelection()!.anchorNode).toBe(host.firstChild)
  expect(getSelection()!.anchorOffset).toBe(0)
  expect(holi().vim.mode().mode).toBe('insert')
  expect(press('X').defaultPrevented).toBe(false)
})

test('plaintext-only ownership is invalidated by every observed DOM eligibility transition', async () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'plaintext-only')
  host.setAttribute('tabindex', '0')
  host.append(document.createTextNode('alpha'), document.createTextNode(' beta'))
  document.body.append(host)
  host.focus()
  const initialRange = document.createRange()
  initialRange.setStart(host.firstChild!, 0)
  initialRange.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(initialRange)
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 42, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  const escape = press('Escape')
  expect(escape.defaultPrevented).toBe(true)
  expect(holi().vim.mode().mode).toBe('normal')

  host.append(document.createElement('span'))
  host.lastChild?.remove()
  expect(press('x').defaultPrevented).toBe(false)
  expect(holi().vim.mode().mode).toBe('insert')

  press('Escape')
  host.setAttribute('contenteditable', 'true')
  host.setAttribute('contenteditable', 'plaintext-only')
  expect(press('x').defaultPrevented).toBe(false)
  expect(holi().vim.mode().mode).toBe('insert')

  press('Escape')
  host.setAttribute('contenteditable', 'false')
  host.setAttribute('contenteditable', 'plaintext-only')
  expect(press('x').defaultPrevented).toBe(false)
  expect(holi().vim.mode().mode).toBe('insert')
  await Promise.resolve()
})

test('plaintext-only host bounds and inherited editing are conservative', () => {
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 43, nonce)
  const cases = [
    '<my-editor contenteditable="plaintext-only">plain</my-editor>',
    '<div contenteditable="plaintext-only" role="textbox">plain</div>',
    '<div contenteditable="plaintext-only"><span>nested</span></div>',
    '<div contenteditable="plaintext-only">line\nbreak</div>',
  ]
  for (const html of cases) {
    const wrapper = document.createElement('section')
    wrapper.innerHTML = html
    const host = wrapper.firstElementChild as HTMLElement
    document.body.append(wrapper)
    host.focus()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    expect(event.defaultPrevented, html).toBe(false)
    wrapper.remove()
  }
  const empty = document.createElement('div')
  empty.setAttribute('contenteditable', 'plaintext-only')
  empty.setAttribute('tabindex', '0')
  document.body.append(empty)
  empty.focus()
  const emptyRange = document.createRange()
  emptyRange.setStart(empty, 0)
  emptyRange.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(emptyRange)
  const emptyEscape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  empty.dispatchEvent(emptyEscape)
  expect(emptyEscape.defaultPrevented).toBe(true)
  empty.remove()

  const parent = document.createElement('div')
  parent.setAttribute('contenteditable', '')
  const child = document.createElement('span')
  child.setAttribute('contenteditable', 'plaintext-only')
  child.setAttribute('tabindex', '0')
  child.textContent = 'plain'
  parent.append(child)
  document.body.append(parent)
  child.focus()
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  child.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  parent.remove()
})

test('plaintext-only selection loss resets ownership before Escape and other keys', () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'plaintext-only')
  host.setAttribute('tabindex', '0')
  host.append(document.createTextNode('plain'))
  document.body.append(host)
  host.focus()
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 44, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  press('Escape')
  const outside = document.createElement('textarea')
  document.body.append(outside)
  outside.focus()
  outside.setSelectionRange(0, 0)
  host.focus()
  const range = document.createRange()
  range.selectNodeContents(outside)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  expect(press('Escape').defaultPrevented).toBe(false)
  expect(holi().vim.mode().mode).toBe('insert')
  expect(press('h').defaultPrevented).toBe(false)
})

test('plaintext-only selectionchange outside the host retires normal ownership', () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'plaintext-only')
  host.setAttribute('tabindex', '0')
  host.append(document.createTextNode('plain'))
  const outside = document.createElement('textarea')
  document.body.append(host, outside)
  host.focus()
  const range = document.createRange()
  range.setStart(host.firstChild!, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 45, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  press('Escape')
  outside.focus()
  outside.setSelectionRange(0, 0)
  const outsideRange = document.createRange()
  outsideRange.selectNodeContents(outside)
  outsideRange.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(outsideRange)
  document.dispatchEvent(new Event('selectionchange'))
  const restored = document.createRange()
  restored.setStart(host.firstChild!, 0)
  restored.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(restored)
  host.focus()
  expect(holi().vim.mode().mode).toBe('insert')
  expect(press('h').defaultPrevented).toBe(false)
})

test('plaintext-only shape loss resets normal mode and does not resurrect it', () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'plaintext-only')
  host.setAttribute('tabindex', '0')
  host.append(document.createTextNode('alpha beta'))
  document.body.append(host)
  host.focus()
  const initialRange = document.createRange()
  initialRange.setStart(host.firstChild!, 0)
  initialRange.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(initialRange)
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 46, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  press('Escape')
  expect(holi().vim.mode().mode).toBe('normal')
  host.append(document.createElement('span'))
  expect(holi().vim.mode().mode).toBe('insert')
  host.lastChild?.remove()
  expect(holi().vim.mode().mode).toBe('insert')
  expect(press('x').defaultPrevented).toBe(false)
})

test.each(['input', 'textarea'] as const)(
  'class mutations on an owned %s do not reset Vim normal mode',
  async (tag) => {
    const field = document.createElement(tag)
    field.value = 'alpha'
    document.body.append(field)
    field.focus()
    const nonce = holi().vim.documentNonce()
    holi().vim.configure(true, 47, nonce)
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      field.dispatchEvent(event)
      return event
    }
    press('Escape')
    expect(holi().vim.mode().mode).toBe('normal')
    field.classList.add('active')
    await Promise.resolve()
    field.setSelectionRange(2, 2)
    expect(press('h').defaultPrevented).toBe(true)
    expect(field.selectionStart).toBe(1)
    expect(field.value).toBe('alpha')
    expect(holi().vim.mode().mode).toBe('normal')
  },
)

test('rich inline native hosts retain formatting and links while motions cross nodes', () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'true')
  host.setAttribute('tabindex', '0')
  host.setAttribute('aria-label', 'rich')
  host.style.display = 'block'
  Object.defineProperty(host, 'isContentEditable', { value: true })
  host.innerHTML =
    '<strong style="display:inline">café</strong><a href="/next" style="display:inline">🙂 two</a><em style="display:inline"></em>'
  document.body.append(host)
  host.focus()
  const originalMarkup = host.innerHTML
  const richReference = Number(
    holi()
      .read(12_000)
      .text.match(/\[(\d+)\] textbox "rich"/)?.[1],
  )
  expect(richReference).toBeGreaterThan(0)
  expect(holi().fill(richReference, 'replacement')).toBe(false)
  expect(host.innerHTML).toBe(originalMarkup)
  const first = host.querySelector('strong')!.firstChild!
  const range = document.createRange()
  range.setStart(first, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 60, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  expect(press('Escape').defaultPrevented).toBe(true)
  expect(holi().vim.mode().mode).toBe('normal')
  expect(press('w').defaultPrevented).toBe(true)
  expect(getSelection()!.anchorNode).toBe(host.querySelector('a')!.firstChild)
  expect(getSelection()!.anchorOffset).toBe(3)
  expect(host.innerHTML).toBe(
    '<strong style="display:inline">café</strong><a href="/next" style="display:inline">🙂 two</a><em style="display:inline"></em>',
  )
  expect(press('a').defaultPrevented).toBe(true)
  expect(holi().vim.mode().mode).toBe('insert')
  expect(getSelection()!.anchorNode).toBe(host.querySelector('a')!.firstChild)
  expect(getSelection()!.anchorOffset).toBe(4)
  const typing = new KeyboardEvent('keydown', { key: '!', bubbles: true, cancelable: true })
  host.dispatchEvent(typing)
  expect(typing.defaultPrevented).toBe(false)
})

test('rich host ownership retires for synchronous and asynchronous DOM transitions', async () => {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'true')
  host.setAttribute('tabindex', '0')
  host.style.display = 'block'
  host.innerHTML =
    '<strong style="display:inline">alpha</strong> beta <a href="/next" style="display:inline">link</a>'
  Object.defineProperty(host, 'isContentEditable', { value: true })
  document.body.append(host)
  host.focus()
  const select = () => {
    const range = document.createRange()
    range.setStart(host.querySelector('strong')!.firstChild!, 0)
    range.collapse(true)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  }
  select()
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 63, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  const enterNormal = () => {
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(holi().vim.mode().mode).toBe('normal')
  }
  const nativeAfterInvalidation = () => {
    expect(holi().vim.mode().mode).toBe('insert')
    expect(press('x').defaultPrevented).toBe(false)
  }

  enterNormal()
  host.querySelector('strong')!.firstChild!.textContent = 'changed'
  nativeAfterInvalidation()

  select()
  enterNormal()
  const link = host.querySelector('a')!
  link.removeAttribute('href')
  link.setAttribute('href', '/next')
  nativeAfterInvalidation()

  select()
  enterNormal()
  host.setAttribute('contenteditable', 'false')
  host.setAttribute('contenteditable', 'true')
  nativeAfterInvalidation()

  select()
  enterNormal()
  host.style.display = 'inline'
  host.style.display = 'block'
  nativeAfterInvalidation()

  select()
  enterNormal()
  const formatted = host.querySelector('strong')!
  formatted.setAttribute('inert', '')
  formatted.removeAttribute('inert')
  nativeAfterInvalidation()

  select()
  enterNormal()
  formatted.style.display = 'block'
  formatted.style.display = 'inline'
  nativeAfterInvalidation()

  select()
  enterNormal()
  host.append(document.createElement('span'))
  await Promise.resolve()
  nativeAfterInvalidation()
})

test('rich host structure is revalidated before each command and unsupported DOM remains native', () => {
  const nonce = holi().vim.documentNonce()
  holi().vim.configure(true, 61, nonce)
  const cases = [
    '<div contenteditable="true" tabindex="0">one<br>two</div>',
    '<div contenteditable="true" tabindex="0"><p>block</p></div>',
    '<div contenteditable="true" tabindex="0"><span style="display:block">block span</span></div>',
    '<div contenteditable="true" tabindex="0">atom<span contenteditable="false">x</span></div>',
    '<div contenteditable="true" tabindex="0">one<span inert>skip</span> two</div>',
    '<div contenteditable="true" tabindex="0" inert>inactive host</div>',
    '<div contenteditable="true" tabindex="0"><span contenteditable="true">nested</span></div>',
    '<div contenteditable="true" tabindex="0">line\nbreak</div>',
  ]
  for (const html of cases) {
    const host = document.createElement('div')
    host.innerHTML = html
    const candidate = host.firstElementChild as HTMLElement
    document.body.append(candidate)
    candidate.focus()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    candidate.dispatchEvent(event)
    expect(event.defaultPrevented, html).toBe(false)
    candidate.remove()
  }
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'true')
  host.setAttribute('tabindex', '0')
  host.style.display = 'block'
  host.innerHTML = '<b style="display:inline">alpha</b> beta'
  document.body.append(host)
  host.focus()
  const range = document.createRange()
  range.setStart(host.querySelector('b')!.firstChild!, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  holi().vim.configure(true, 62, nonce)
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event
  }
  press('Escape')
  host.append(document.createElement('br'))
  expect(press('x').defaultPrevented).toBe(false)
  expect(host.innerHTML).toBe('<b style="display:inline">alpha</b> beta<br>')
  expect(holi().vim.mode().mode).toBe('insert')
})

test('fills a field and picks an option, as typing would', () => {
  holi().read(12_000)
  const input = vi.fn()
  document.getElementById('email')!.addEventListener('input', input)
  expect(holi().focus(3)).toBe(true)
  expect(holi().fill(3, 'ada@example.com')).toBe(true)
  expect(holi().valueOf(3)).toBe('ada@example.com')
  expect(input).toHaveBeenCalled()
  expect(holi().fill(6, 'Sweden')).toBe(true)
  expect(holi().valueOf(6)).toBe('Sweden')
  expect(holi().fill(6, 'Norway')).toBe(false)
})
