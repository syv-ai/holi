/**
 * How see-through the window is on a Mac: the vault's machine-local
 * `windowGlass` (`.holi/settings/app.local.yaml`), stamped on <html> as
 * `data-glass` for `index.css` (Glass) to tint the chrome by. Read and written
 * the way `colorScheme` is (`color-scheme.ts`).
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { VAULT_SETTING_DEFAULTS, type WindowGlass } from '@holi/shared'
import { trpc } from '@/lib/trpc'
import { loadVaultSettingsAtom, vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

/** What the active vault asked for. */
export const windowGlassAtom = atom<WindowGlass>(VAULT_SETTING_DEFAULTS.windowGlass)

/** Keep the document stamped with the vault's glass. Call once, from the root. */
export function useWindowGlass(): void {
  const cached = useAtomValue(vaultSettingsAtom)
  const setGlass = useSetAtom(windowGlassAtom)
  const glass = useAtomValue(windowGlassAtom)

  useEffect(() => {
    setGlass(cached?.settings.windowGlass ?? VAULT_SETTING_DEFAULTS.windowGlass)
  }, [cached, setGlass])

  useEffect(() => {
    document.documentElement.dataset.glass = glass
  }, [glass])
}

/** Choose the glass from outside Settings (the profile menu): applied at once,
 *  then written and re-read so the cache agrees with the file. */
export const writeWindowGlassAtom = atom(null, async (get, set, glass: WindowGlass) => {
  const remote = get(activeRemoteAtom)
  set(windowGlassAtom, glass)
  if (remote === null) return
  const cached = get(vaultSettingsAtom)
  if (cached !== null && cached.remote === remote) {
    set(vaultSettingsAtom, { remote, settings: { ...cached.settings, windowGlass: glass } })
  }
  await trpc.settings.write.mutate({ remote, localJson: JSON.stringify({ windowGlass: glass }) })
  await set(loadVaultSettingsAtom, { force: true })
})
