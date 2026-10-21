/**
 * What the quick agent's two pages, the panel and the dock, set up alike
 * (docs/features/quick-agent.md): the dark HUD, in the open vault's colours,
 * and the answer to main's `paint`.
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

/**
 * Main's `paint`, sent as it brings the window out, answered once the page has
 * painted what it shows now: two frames on, which for a page out of sight is
 * after it is in sight again. Until then main keeps the window clear, since a
 * window shown again would first show its last frame (`surface.ts`).
 */
export function usePaintAnswer(painted: () => void): void {
  useEffect(
    () =>
      window.holi.page.on(({ name }) => {
        if (name === 'paint') requestAnimationFrame(() => requestAnimationFrame(painted))
      }),
    [painted],
  )
}
