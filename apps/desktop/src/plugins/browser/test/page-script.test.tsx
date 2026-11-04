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
