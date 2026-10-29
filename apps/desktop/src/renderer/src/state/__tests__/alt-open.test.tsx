import { expect, test } from 'vitest'

import { openingBeside } from '../alt-open'

test('a ⌥-click opens one thing beside, a plain click none', () => {
  window.dispatchEvent(new MouseEvent('click', { altKey: true }))
  expect(openingBeside()).toBe(true)
  // Reading spends it.
  expect(openingBeside()).toBe(false)
  window.dispatchEvent(new MouseEvent('click', { altKey: false }))
  expect(openingBeside()).toBe(false)
})

test('⌥↩ counts as the gesture too', () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true }))
  expect(openingBeside()).toBe(true)
})
