/**
 * The notes editor's prose font, stamped as a CSS custom property.
 *
 * The vault says `editorFont: 'mono' | 'sans' | 'serif'` in
 * `.holi/settings/app.yaml` (or per machine in `app.local.yaml`); the name
 * resolves to a stack in `@holi/shared` and lands on `:root` as `--editor-font`,
 * which `notesFontTheme` reads. A name rather than a font-family string, because
 * in a shared vault the committed file is written by someone else.
 *
 * **A variable rather than a CodeMirror compartment**: the setting only changes
 * on a vault switch, and one property restyles every open editor at once. The
 * theme carries the default's stack as the var's fallback.
 *
 * No atom, unlike `useColorScheme`: the CSS is the only consumer.
 */
import { useAtomValue } from 'jotai'
import { useEffect } from 'react'
import { EDITOR_FONT_STACKS, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { vaultSettingsAtom } from './settings'

/** The custom property `notesFontTheme` reads. */
export const EDITOR_FONT_VAR = '--editor-font'

/** Keep `:root` carrying the active vault's editor font. Call once, from the
 *  root, as with `useColorScheme`. */
export function useEditorFont(): void {
  const cached = useAtomValue(vaultSettingsAtom)
  const font = cached?.settings.editorFont ?? VAULT_SETTING_DEFAULTS.editorFont

  useEffect(() => {
    document.documentElement.style.setProperty(EDITOR_FONT_VAR, EDITOR_FONT_STACKS[font])
  }, [font])
}
