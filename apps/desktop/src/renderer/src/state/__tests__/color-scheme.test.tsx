/**
 * Light, dark, or the OS, and the stamp that makes it real.
 *
 * The resolution itself is `resolveColorMode` in `@holi/shared`, tested there on
 * plain values. What is left is what only a DOM can show: that the attribute is
 * written for BOTH modes, that the OS is re-asked while the app runs, and that
 * the listener is taken down again.
 */
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, waitFor } from '@/test/render'
import { useColorScheme } from '../color-scheme'
import { vaultSettingsAtom } from '../settings'
import { VAULT_SETTING_DEFAULTS, type ResolvedVaultSettings } from '@holi/shared'

/** A controllable `prefers-color-scheme`. jsdom implements no media queries, and
 *  `test/setup.dom.ts` installs a stub that always answers "no match" — which
 *  would silently mean "the OS is light" in every test here. */
let listeners: ((event: MediaQueryListEvent) => void)[] = []
let systemDark = false

function installMatchMedia() {
  listeners = []
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return query.includes('dark') ? systemDark : false
    },
    addEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) => listeners.push(cb),
    removeEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) => {
      listeners = listeners.filter((l) => l !== cb)
    },
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
}

/** Flip the OS preference and tell whoever is listening. */
function setSystemDark(next: boolean) {
  systemDark = next
  for (const l of [...listeners]) l({ matches: next } as MediaQueryListEvent)
}

const settings = (colorScheme: ResolvedVaultSettings['colorScheme']): ResolvedVaultSettings => ({
  landing: { kind: 'daily' },
  dailyNotes: true,
  colorScheme,
  editorFont: 'mono',
  hooks: VAULT_SETTING_DEFAULTS.hooks,
  maxCommittedFileBytes: 10 * 1024 * 1024,
  warnings: [],
})

function Probe(): null {
  useColorScheme()
  return null
}

/** Mount the probe with a vault whose settings say `scheme` (or no vault). */
function mount(scheme?: ResolvedVaultSettings['colorScheme']) {
  const store = createStore()
  if (scheme !== undefined) {
    store.set(vaultSettingsAtom, { remote: 'me/notes', settings: settings(scheme) })
  }
  const view = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  return { store, view }
}

const stamped = () => document.documentElement.dataset.theme

beforeEach(() => {
  systemDark = false
  installMatchMedia()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

test('stamps dark explicitly, not by leaving the attribute off', async () => {
  // Unstamped happens to resolve dark, so "stamp only for light" would work by
  // accident and leave `color-scheme:` unset with it.
  mount('dark')
  await waitFor(() => expect(stamped()).toBe('dark'))
})

test('stamps light', async () => {
  mount('light')
  await waitFor(() => expect(stamped()).toBe('light'))
})

test('an explicit choice ignores the OS', async () => {
  systemDark = true
  mount('light')
  await waitFor(() => expect(stamped()).toBe('light'))
})

test('system follows the OS at mount', async () => {
  systemDark = true
  mount('system')
  await waitFor(() => expect(stamped()).toBe('dark'))
})

test('system follows the OS while the app is running', async () => {
  // The whole reason there is a listener: without it the app follows the OS only
  // at launch, which reads as a bug the first time a Mac switches at sunset.
  mount('system')
  await waitFor(() => expect(stamped()).toBe('light'))

  setSystemDark(true)
  await waitFor(() => expect(stamped()).toBe('dark'))
})

test('an explicit choice does not move when the OS does', async () => {
  mount('dark')
  await waitFor(() => expect(stamped()).toBe('dark'))

  setSystemDark(true)
  await waitFor(() => expect(stamped()).toBe('dark'))
})

test('follows the OS before any vault is open', async () => {
  // The setting lives in the vault, so the sign-in screen and the ritual have
  // nothing to read. They should still not be stuck dark.
  systemDark = false
  mount()
  await waitFor(() => expect(stamped()).toBe('light'))
})

test('takes the OS listener down on unmount', async () => {
  const { view } = mount('system')
  await waitFor(() => expect(listeners).toHaveLength(1))
  view.unmount()
  expect(listeners).toHaveLength(0)
})

test('follows a vault switch', async () => {
  const { store } = mount('dark')
  await waitFor(() => expect(stamped()).toBe('dark'))

  store.set(vaultSettingsAtom, { remote: 'me/other', settings: settings('light') })
  await waitFor(() => expect(stamped()).toBe('light'))
})
