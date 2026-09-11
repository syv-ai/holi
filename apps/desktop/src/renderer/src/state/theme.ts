/**
 * Applies the active vault's theme to the document root.
 *
 * The theme is a set of whitelisted colour/chrome token values (resolved in main
 * from `.holi/settings/theme.yaml` + `.holi/settings/theme.local.yaml`). Writing them as custom
 * properties on `document.documentElement` re-cascades the app's semantic tokens
 * — `--primary`, `--radius`, `--shadow-popover`, … — because those are `var()`
 * pointers (see `index.css`). It is deliberately the document ROOT and not an
 * inner wrapper: Radix dialogs, popovers and menus portal to `document.body`, so
 * only a root override reaches them.
 *
 * The DOM bookkeeping (diff on switch, clear on the way out) lives in
 * `ThemeApplicator`; this hook is the shell that feeds it from the active-vault
 * atoms and the tRPC read, and surfaces the resolver's warnings so an ignored
 * key is diagnosable rather than silent.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'
import { THEME_TOKENS, themeBlockToVars } from '@holi/shared'
import type { ResolvedTheme } from '@holi/shared'
import { ThemeApplicator } from '../lib/theme-applicator'
import { resolveThemeDefaults } from '../lib/theme-defaults'
import { trpc } from '../lib/trpc'
import { activeModeAtom } from './color-scheme'
import { activeRemoteAtom, snapshotAtom } from './vaults'

/**
 * The tokens a theme file does not yet name, with the values in force — or
 * `null` when it already names them all.
 *
 * **This is what makes the file the source of truth rather than a list of
 * things you could say.** Every declaration arrived commented out, so the file
 * described the vocabulary while `index.css` still decided the colours. Writing
 * the values in force closes that gap once: from then on, the file answers
 * "what colour is this vault?" without the app having to.
 *
 * Only what is MISSING. A token the vault has set is never touched, so this
 * cannot walk over somebody's theme, and once a file is complete it is a no-op
 * — which is what stops the write it triggers from triggering another.
 */
function missingTokens(theme: ResolvedTheme): Record<ThemeModeKey, Record<string, string>> | null {
  const patch: Record<string, Record<string, string>> = {}
  for (const mode of ['dark', 'light'] as const) {
    const have = theme[mode]
    const defaults = resolveThemeDefaults(mode)
    const block: Record<string, string> = {}
    for (const slug of THEME_TOKENS) {
      if (have[slug] !== undefined) continue
      const value = defaults[slug]
      if (value !== undefined) block[slug] = value
    }
    if (Object.keys(block).length > 0) patch[mode] = block
  }
  return Object.keys(patch).length > 0
    ? (patch as Record<ThemeModeKey, Record<string, string>>)
    : null
}

type ThemeModeKey = 'light' | 'dark'

/**
 * Keep `document.documentElement` styled with the active vault's theme. Call once
 * from a component that only mounts when a vault is active (Shell); it clears the
 * applied properties on unmount so a vault palette never lingers on the sign-in
 * or onboarding screens.
 */
export function useVaultTheme(): void {
  const remote = useAtomValue(activeRemoteAtom)
  // The snapshot's object identity changes on every push; used purely as a
  // "vault changed — re-read the theme" tick. The theme file contents are not in
  // the snapshot (non-`.md` files carry only path + mtime), so we re-pull.
  const snapshot = useAtomValue(snapshotAtom)
  // The mode is a dependency, not a read-at-use. A resolved theme carries a
  // `light` and a `dark` block and only one is ever applied, so a flip that did
  // not re-apply would leave the OTHER mode's custom properties sitting on the
  // root: the base palette switches and the vault's overrides do not. That is a
  // worse-looking bug than having no light mode at all, and it is invisible in
  // any vault with no theme file.
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
        // **Fill the file in before applying, not after.** `resolveThemeDefaults`
        // reads through a probe that inherits from `document.documentElement`,
        // so a theme already applied there would be read back as if it were
        // Holi's own default. Clearing first is what makes the values pristine;
        // nothing paints in between, because this is one task.
        applicator.clear()
        const missing = missingTokens(theme)
        applicator.apply(themeBlockToVars(theme[mode]))
        if (missing !== null) {
          void trpc.theme.write
            .mutate({ remote, layer: 'committed', patchJson: JSON.stringify(missing) })
            // A vault that cannot be written to is not a reason to stop showing
            // it. The file stays as it was and the app looks the same either
            // way, because what would have been written is what is on screen.
            .catch(() => {})
        }
      })
      .catch(() => {
        // Leave whatever is applied — the CSS defaults are always valid, and a
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
