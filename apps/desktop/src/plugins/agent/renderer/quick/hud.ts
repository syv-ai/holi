/**
 * What the quick agent's two pages, the panel and the dock, set up alike
 * (docs/features/quick-agent.md): the dark HUD, in the open vault's colours.
 */
import { useSetAtom } from 'jotai'
import { useEffect, useLayoutEffect } from 'react'
import { activeRemoteAtom, useVaultTheme } from '@/plugin-api'

/**
 * The page dark whatever the vault's scheme, wearing `remote`'s dark colours:
 * its theme can recolour the lights, so a dot and its panel agree. The glass
 * shows through everything the page does not paint (`quick.css`, keyed on
 * `data-page`).
 */
export function useHudPage(page: 'quick' | 'dock', remote: string | null): void {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.dataset.page = page
  }, [page])
  useVaultTheme()
  const setRemote = useSetAtom(activeRemoteAtom)
  useEffect(() => setRemote(remote), [remote, setRemote])
}
