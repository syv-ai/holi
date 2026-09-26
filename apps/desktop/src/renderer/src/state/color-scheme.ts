/**
 * Light, dark, or whatever the OS says, and the `data-theme` stamp that makes it
 * real. `:root` in `index.css` carries the dark values and
 * `[data-theme='light']` overrides them.
 *
 * **Both modes are stamped explicitly.** Unstamped happens to resolve dark, but
 * would leave `color-scheme:` unset, which paints the native window background
 * and shows as a white flash at the edges of a dark window.
 *
 * The setting lives in `.holi/settings/app.local.yaml` and so is per vault and per
 * machine. Until a vault is open there is nothing to read, and the default
 * (`system`) applies, which is why the sign-in screen and the ritual follow the
 * OS rather than being stuck dark.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { VAULT_SETTING_DEFAULTS, resolveColorMode, type ColorScheme } from '@holi/shared'
import { vaultSettingsAtom } from './settings'

/** What the active vault asked for. */
export const colorSchemeAtom = atom<ColorScheme>(VAULT_SETTING_DEFAULTS.colorScheme)

/** What the OS currently reports. Kept in a store rather than read at use, so a
 *  change re-renders everything that depends on the resolved mode. */
export const systemPrefersDarkAtom = atom(true)

/** The mode actually in force. */
export const activeModeAtom = atom((get) =>
  resolveColorMode(get(colorSchemeAtom), get(systemPrefersDarkAtom)),
)

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Keep the document stamped with the active mode. Call once, from the root.
 *
 * Three effects rather than one, because they change on different clocks: the
 * vault's setting on a vault switch, the OS preference whenever the user flips
 * it, and the stamp whenever either of those resolves differently.
 */
export function useColorScheme(): void {
  const cached = useAtomValue(vaultSettingsAtom)
  const setScheme = useSetAtom(colorSchemeAtom)
  const setSystemPrefersDark = useSetAtom(systemPrefersDarkAtom)
  const mode = useAtomValue(activeModeAtom)

  // The vault's answer, or the default while no vault is open.
  useEffect(() => {
    setScheme(cached?.settings.colorScheme ?? VAULT_SETTING_DEFAULTS.colorScheme)
  }, [cached, setScheme])

  // The OS preference, and every change to it for as long as the app runs.
  // Without the listener the app would follow the OS only at launch.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    setSystemPrefersDark(query.matches)
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [setSystemPrefersDark])

  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])
}
