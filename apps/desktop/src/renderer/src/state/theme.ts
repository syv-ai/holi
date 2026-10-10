/**
 * Applies the active vault's theme to the document root.
 *
 * The theme is a set of whitelisted colour/chrome token values (resolved in main
 * from `.holi/settings/theme.css` + `.holi/settings/theme.local.css`). Writing
 * them as custom properties on `document.documentElement` re-cascades the app's
 * semantic tokens, which are `var()` pointers (see `index.css`). The ROOT, not an
 * inner wrapper: Radix dialogs, popovers and menus portal to `document.body`.
 *
 * The DOM bookkeeping lives in `ThemeApplicator`; this hook feeds it and
 * surfaces the resolver's warnings so an ignored key is diagnosable.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'
import { themeBlockToVars } from '@holi/shared'
import { ThemeApplicator } from '../lib/theme-applicator'
import { trpc } from '../lib/trpc'
import { activeModeAtom } from './color-scheme'
import { activeRemoteAtom, snapshotAtom } from './vaults'

/**
 * Keep `document.documentElement` styled with the active vault's theme. Call once
 * from a component that only mounts when a vault is active (Shell); it clears the
 * applied properties on unmount so a vault palette never lingers on the sign-in
 * or onboarding screens.
 */
export function useVaultTheme(): void {
  const remote = useAtomValue(activeRemoteAtom)
  // The snapshot's object identity changes on every push; used purely as a
  // "vault changed, re-read the theme" tick. The theme file contents are not in
  // the snapshot (non-`.md` files carry only path + mtime), so we re-pull.
  const snapshot = useAtomValue(snapshotAtom)
  // The mode is a dependency, not a read-at-use. A resolved theme carries a
  // `light` and a `dark` block and only one is ever applied, so a flip that did
  // not re-apply would leave the OTHER mode's custom properties sitting on the
  // root: the base palette switches and the vault's overrides do not.
  const mode = useAtomValue(activeModeAtom)
  // A stable instance across renders. Read inside the effects (a ref, so not an
  // effect dependency), which keeps the diff/clear state with the DOM it owns.
  const applicatorRef = useRef<ThemeApplicator | null>(null)
  applicatorRef.current ??= new ThemeApplicator(document.documentElement)

  useEffect(() => {
    const applicator = applicatorRef.current!
    let cancelled = false
    if (!remote) {
      applicator.clear()
      return
    }
    trpc.theme.read
      .query({ remote })
      .then((theme) => {
        if (cancelled) return
        if (theme.warnings.length > 0) {
          console.warn(
            `[theme] ${theme.warnings.length} key(s) ignored for ${remote}:\n` +
              theme.warnings.map((w) => `  • ${w}`).join('\n'),
          )
        }
        // The file is the vault's: applied as it is, never filled in. A token it
        // leaves out shows Holi's built-in value from `index.css`.
        applicator.apply(themeBlockToVars(theme[mode]))
      })
      .catch(() => {
        // Leave whatever is applied: the CSS defaults are always valid, and a
        // transient read failure must not strip the user's theme.
      })
    return () => {
      cancelled = true
    }
  }, [remote, snapshot, mode])

  // Clear on unmount only (Shell → sign-in/onboarding), so a vault palette never
  // lingers on a screen that isn't the vault.
  useEffect(() => {
    const applicator = applicatorRef.current!
    return () => applicator.clear()
  }, [])
}
