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
  vim: {
    documentNonce(): string
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

test('vim mode uses native selections and blocks unsupported edits synchronously', () => {
  const textarea = document.createElement('textarea')
  textarea.value = 'one two\n  three'
  document.body.append(textarea)
  textarea.focus()
  const nonce = holi().vim.documentNonce()
  expect(holi().vim.configure(true, 1, nonce)).toBe(true)
  expect(holi().vim.mode()).toEqual({ revision: 1, mode: 'insert' })
  const key = (value: string) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
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
