/**
 * Tells CodeMirror which colour mode it is in. Its base theme picks between
 * `&light` / `&dark` rules from `EditorView.darkTheme`, and unset means light.
 *
 * Read off the root's `data-theme` stamp ("system" is resolved before
 * stamping). A MutationObserver rather than a prop, because a view outlives a
 * theme flip.
 */
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/** Dark-first, matching `index.css`: only an explicit `light` stamp is light. */
function isDark(): boolean {
  return document.documentElement.dataset['theme'] !== 'light'
}

/** Module-level, so a reconfigure can find it; the value inside is per state. */
const mode = new Compartment()

/** Call it, do not hoist it: the initial value must be the mode in force when
 *  the view is built. */
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
