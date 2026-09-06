/**
 * The notes editor's prose font, stamped as a CSS custom property.
 *
 * The vault says `editorFont: 'mono' | 'sans' | 'serif'` in `.holi/settings.json`
 * or overrides it per machine in `.holi/settings.local.json`; the name resolves
 * to a stack in `@holi/shared` and lands on `:root` as `--editor-font`, which
 * `notesFontTheme` reads. A name rather than a font-family string is the point:
 * the committed file is written by whoever wrote the vault, and in a shared one
 * that is not you.
 *
 * **A variable rather than a CodeMirror compartment**, because the setting can
 * only change on a vault switch (`vaultSettingsAtom` is read once per vault) and
 * one property restyles every open editor at once, with no reconfiguration and
 * no per-view plumbing. The theme carries the mono stack as the var's fallback,
 * so an editor mounted before this has run looks exactly as it always has.
 *
 * Deliberately NOT `useColorScheme`'s shape: no atom, because nothing in the app
 * reads the value. The CSS is the only consumer.
 */
import { useAtomValue } from 'jotai'
import { useEffect } from 'react'
import { EDITOR_FONT_STACKS, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { vaultSettingsAtom } from './settings'

/** The custom property `notesFontTheme` reads. */
export const EDITOR_FONT_VAR = '--editor-font'

/** Keep `:root` carrying the active vault's editor font. Call once, from the
 *  root — the same place `useColorScheme` is called and for the same reason. */
export function useEditorFont(): void {
  const cached = useAtomValue(vaultSettingsAtom)
  const font = cached?.settings.editorFont ?? VAULT_SETTING_DEFAULTS.editorFont

  useEffect(() => {
    document.documentElement.style.setProperty(EDITOR_FONT_VAR, EDITOR_FONT_STACKS[font])
  }, [font])
}
