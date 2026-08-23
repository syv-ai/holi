import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ResolvedTheme } from '@holi/shared'
import { render, waitFor } from '@/test/render'
import { useVaultTheme } from '../theme'
import { colorSchemeAtom } from '../color-scheme'
import { activeRemoteAtom } from '../vaults'

// Controllable stand-in for the theme read — keyed by remote so a vault switch
// returns a different palette. Only `theme.read` is exercised here; the rest of
// the tRPC surface is untouched because we drive the atoms directly.
const readMock = vi.fn<(input: { remote: string }) => Promise<ResolvedTheme>>()
vi.mock('../../lib/trpc', () => ({
  trpc: { theme: { read: { query: (input: { remote: string }) => readMock(input) } } },
}))

function empty(dark: Record<string, string>): ResolvedTheme {
  return { light: {}, dark, warnings: [] }
}

function Probe(): null {
  useVaultTheme()
  return null
}

const root = () => document.documentElement

beforeEach(() => {
  readMock.mockReset()
})
afterEach(() => {
  // Leave the root clean for the next test regardless of what a case applied.
  for (const name of ['--primary', '--radius', '--background']) root().style.removeProperty(name)
})

test('applies the active vault dark block onto the document root', async () => {
  readMock.mockResolvedValue(empty({ primary: '#f00', radius: '1rem' }))
  const store = createStore()
  store.set(activeRemoteAtom, 'me/one')
  render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  await waitFor(() => expect(root().style.getPropertyValue('--primary')).toBe('#f00'))
  expect(root().style.getPropertyValue('--radius')).toBe('1rem')
})

test('switching vaults removes the previous vault keys not in the new theme', async () => {
  readMock.mockImplementation(({ remote }) =>
    Promise.resolve(
      remote === 'me/one' ? empty({ primary: '#f00', radius: '1rem' }) : empty({ primary: '#0f0' }),
    ),
  )
  const store = createStore()
  store.set(activeRemoteAtom, 'me/one')
  render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  await waitFor(() => expect(root().style.getPropertyValue('--radius')).toBe('1rem'))

  store.set(activeRemoteAtom, 'me/two')
  // radius was vault one's; vault two doesn't set it, so it must be cleared,
  // while primary is overwritten to the new value.
  await waitFor(() => expect(root().style.getPropertyValue('--primary')).toBe('#0f0'))
  expect(root().style.getPropertyValue('--radius')).toBe('')
})

test('surfaces resolver warnings so an ignored key is diagnosable', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  readMock.mockResolvedValue({
    light: {},
    dark: { primary: '#f00' },
    warnings: ['dropped unknown token "width" (dark)'],
  })
  const store = createStore()
  store.set(activeRemoteAtom, 'me/one')
  render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  await waitFor(() => expect(root().style.getPropertyValue('--primary')).toBe('#f00'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('width'))
  warn.mockRestore()
})

test('clears applied properties on unmount', async () => {
  readMock.mockResolvedValue(empty({ primary: '#f00' }))
  const store = createStore()
  store.set(activeRemoteAtom, 'me/one')
  const { unmount } = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  await waitFor(() => expect(root().style.getPropertyValue('--primary')).toBe('#f00'))
  unmount()
  expect(root().style.getPropertyValue('--primary')).toBe('')
})

test('re-applies the vault theme when the colour scheme flips', async () => {
  // The load-bearing case for the mode being a DEPENDENCY rather than a
  // read-at-use. A resolved theme carries both blocks and only one is ever on
  // the root, so a flip that did not re-apply would switch the base palette and
  // leave the OTHER mode's vault overrides sitting there. Invisible in any vault
  // with no theme file, which is most of them.
  readMock.mockResolvedValue({
    light: { primary: '#111111' },
    dark: { primary: '#eeeeee' },
    warnings: [],
  })
  const store = createStore()
  store.set(activeRemoteAtom, 'me/one')
  store.set(colorSchemeAtom, 'dark')
  render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  await waitFor(() => expect(root().style.getPropertyValue('--primary')).toBe('#eeeeee'))

  store.set(colorSchemeAtom, 'light')
  await waitFor(() => expect(root().style.getPropertyValue('--primary')).toBe('#111111'))
})
