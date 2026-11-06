import { atom, useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'
import { THEME_FILE, THEME_LOCAL_FILE, themeBlockToVars, type ResolvedTheme } from '@holi/shared'
import { trpc } from '@/lib/trpc'
import { activeModeAtom } from './color-scheme'
import { activeRemoteAtom, snapshotAtom } from './vaults'

const themeFilesAtom = atom((get) => {
  const paths = new Set([THEME_FILE, THEME_LOCAL_FILE])
  return get(snapshotAtom)
    .files.filter((file) => paths.has(file.path))
    .map((file) => `${file.path}@${file.updatedAt}`)
    .sort()
    .join('|')
})

/** Apply only resolved tokens, removing stale theme-owned vars.
 * @public exported for theme ownership tests
 */
export function applyVaultTheme(
  root: HTMLElement,
  block: Record<string, string>,
  previous: ReadonlySet<string>,
): Set<string> {
  const vars = themeBlockToVars(block)
  for (const name of previous) if (!(name in vars)) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  return new Set(Object.keys(vars))
}

/** Keep the active vault's resolved theme on the root without owning other styles. */
export function useVaultTheme(): void {
  const remote = useAtomValue(activeRemoteAtom)
  const mode = useAtomValue(activeModeAtom)
  const files = useAtomValue(themeFilesAtom)
  const previous = useRef<Set<string>>(new Set())
  const generation = useRef(0)
  const previousRemote = useRef<string | null>(null)
  const appliedValues = useRef(new Map<string, string>())

  useEffect(() => {
    const current = ++generation.current
    let live = true
    const root = document.documentElement
    if (previousRemote.current !== remote) {
      previous.current = applyVaultTheme(root, {}, previous.current)
      previousRemote.current = remote
    }
    if (remote === null) {
      previous.current = applyVaultTheme(root, {}, previous.current)
      return () => {
        live = false
      }
    }
    void trpc.theme.read
      .query({ remote })
      .then((theme: ResolvedTheme) => {
        if (!live || current !== generation.current) return
        const block = theme[mode]
        previous.current = applyVaultTheme(root, block, previous.current)
        appliedValues.current = new Map(
          Object.entries(themeBlockToVars(block)).map(([name, value]) => [name, value]),
        )
      })
      .catch((error: unknown) => {
        if (live && current === generation.current) {
          console.warn('[theme] re-read failed:', error)
        }
      })
    return () => {
      live = false
    }
  }, [files, mode, remote])

  useEffect(
    () => () => {
      const root = document.documentElement
      for (const [name, value] of appliedValues.current) {
        if (root.style.getPropertyValue(name) === value) root.style.removeProperty(name)
      }
      previous.current.clear()
      appliedValues.current.clear()
    },
    [],
  )
}
