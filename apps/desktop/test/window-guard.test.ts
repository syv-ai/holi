/**
 * What the window is allowed to navigate to.
 *
 * The reason this exists is a dropped file. An unclaimed file drop is a
 * navigation, and Electron answers a navigation by loading the file — which is
 * how a PDF dropped on the tree became a blank window (afa30b3 fixed the drop
 * itself; this is the backstop for every drop surface that has not been
 * audited). Holi is a single page that never navigates on purpose, so the
 * honest rule is "the document we loaded, and nothing else".
 */
import { expect, test } from 'vitest'
import { isAllowedNavigation } from '../src/main/window-guard'

const DEV = 'http://localhost:5173'
const PROD = 'file:///Applications/Holi.app/Contents/Resources/app/out/renderer/index.html'

test('the dev server may reload itself', () => {
  // Vite's full reload goes to the same URL with a trailing slash, and HMR adds
  // a query. Both are the app, and blocking either would break the dev loop.
  expect(isAllowedNavigation(DEV, DEV)).toBe(true)
  expect(isAllowedNavigation(DEV, `${DEV}/`)).toBe(true)
  expect(isAllowedNavigation(DEV, `${DEV}/?t=1730`)).toBe(true)
  expect(isAllowedNavigation(DEV, `${DEV}/index.html`)).toBe(true)
})

test('the packaged app may reload itself', () => {
  expect(isAllowedNavigation(PROD, PROD)).toBe(true)
  expect(isAllowedNavigation(PROD, `${PROD}#/notes`)).toBe(true)
})

test('a dropped file is refused', () => {
  // The whole point. In a packaged build the app AND the dropped file are both
  // `file://`, so an origin comparison would let this through — `file:` URLs
  // have no meaningful origin. The path is what separates them.
  expect(isAllowedNavigation(PROD, 'file:///Users/ada/Downloads/paper.pdf')).toBe(false)
  expect(isAllowedNavigation(DEV, 'file:///Users/ada/Downloads/paper.pdf')).toBe(false)
})

test('a dropped file living beside the app bundle is still refused', () => {
  // Same directory as the real document, so a prefix or dirname test would pass
  // it. Nothing but the document itself is the app.
  expect(
    isAllowedNavigation(PROD, 'file:///Applications/Holi.app/Contents/Resources/app/out/renderer/notes.md'),
  ).toBe(false)
})

test('an outside site is refused', () => {
  // A link that escaped `openExternal`, or a page that redirected itself.
  expect(isAllowedNavigation(DEV, 'https://example.com')).toBe(false)
  expect(isAllowedNavigation(PROD, 'https://example.com')).toBe(false)
  // A different dev port is a different app, not this one.
  expect(isAllowedNavigation(DEV, 'http://localhost:5174')).toBe(false)
})

test('a vault app’s own origin is refused at the top level', () => {
  // `holi-app://` belongs in the app frame, which navigates as a subframe and
  // never reaches this guard. Loading one as the whole window would replace
  // Holi with the app — the exact escape the per-app origin exists to prevent.
  expect(isAllowedNavigation(PROD, 'holi-app://retro-board/index.html')).toBe(false)
})

test('a malformed URL is refused rather than throwing', () => {
  // `new URL` throws on junk, and a guard that throws inside an Electron event
  // handler fails open — the navigation proceeds.
  expect(isAllowedNavigation(PROD, 'not a url')).toBe(false)
  expect(isAllowedNavigation('not a url', PROD)).toBe(false)
})
