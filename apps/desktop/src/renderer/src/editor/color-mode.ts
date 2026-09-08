/**
 * Tells CodeMirror which colour mode it is in.
 *
 * CodeMirror's own base theme is written as `&light` / `&dark` pairs, and it
 * picks between them from `EditorView.darkTheme` — a facet nothing here was
 * setting. Unset means light, so every editor in this dark-first app has been
 * wearing CodeMirror's light chrome. Its selection is the one that showed:
 * a near-white `#d7d4f0` painted over a near-black page, from a rule five
 * classes deep that the theme's own two-class rule never beat.
 *
 * The mode is read where the rest of the app reads it, off the `data-theme`
 * stamp on the root element — D85 resolves "system" to an explicit value before
 * stamping, so there is no third state here. A MutationObserver rather than a
 * prop, because a view outlives a theme flip: the panes are rebuilt per
 * document, not per mode, and this way every stack that borrows `editorTheme`
 * gets it without three call sites having to remember.
 */
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/** Dark-first, matching `index.css`: only an explicit `light` stamp is light. */
function isDark(): boolean {
  return document.documentElement.dataset['theme'] !== 'light'
}

/** Module-level, so a reconfigure can find it; the value inside is per state. */
const mode = new Compartment()

/** Call it, do not hoist it: the initial value has to be the mode in force when
 *  the view is built, not the one that happened to be on at import. */
export function colorModeAware(): Extension {
  return [
    mode.of(EditorView.darkTheme.of(isDark())),
    ViewPlugin.fromClass(
      class {
        private dark = isDark()
        private readonly observer: MutationObserver

        constructor(view: EditorView) {
          this.observer = new MutationObserver(() => {
            const dark = isDark()
            if (dark === this.dark) return
            this.dark = dark
            view.dispatch({ effects: mode.reconfigure(EditorView.darkTheme.of(dark)) })
          })
          this.observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
          })
        }

        destroy(): void {
          this.observer.disconnect()
        }
      },
    ),
  ]
}
