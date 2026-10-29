/**
 * Whether the personas suit up: the superhero in the dark theme, the everyday
 * look in the light. Read off the `data-theme` that `useColorScheme` stamps on
 * <html> (already resolved, so `system` arrives as light or dark), with the
 * OS preference as the answer before anything is stamped.
 */
import { useSyncExternalStore } from 'react'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The theme in force right now, read straight off the document. */
export function heroModeNow(): boolean {
  if (typeof document === 'undefined') return false
  const theme = document.documentElement.dataset.theme
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  query?.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    query?.removeEventListener('change', onChange)
  }
}

/** The hero look while the dark theme is in force, re-rendering on a switch. */
export function useHeroMode(): boolean {
  return useSyncExternalStore(subscribe, heroModeNow, () => false)
}
