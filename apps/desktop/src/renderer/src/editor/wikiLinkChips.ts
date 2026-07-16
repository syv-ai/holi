import { WidgetType } from '@codemirror/view'

/**
 * Inline chip for `[[path]]` / `[[path|Label]]` (notes-editor PRD FR-6) and for
 * `[[task:<id>]]` task refs (D27).
 *
 * One widget, two kinds. They differ only in what a click means and in where "does the
 * target exist?" is answered — a note chip carries a vault path and opens a note; a task
 * chip carries a stable id and opens the task. Everything else (the reveal-on-active-line
 * behaviour, the missing styling, `ignoreEvent`) is identical, so a second widget class
 * would fork all of it to express one difference.
 *
 * `label` arrives already resolved: the caller has folded in the `|Label` override and,
 * for a task, the id→title join. The widget renders what it is handed and does not look
 * anything up — which is what keeps `eq` an honest identity check, since two chips that
 * compare equal really do draw the same.
 */
export class WikiLinkChip extends WidgetType {
  constructor(
    readonly kind: 'note' | 'task',
    readonly target: string,
    readonly label: string,
    readonly exists: boolean,
  ) {
    super()
  }

  override eq(other: WikiLinkChip): boolean {
    return (
      other.kind === this.kind &&
      other.target === this.target &&
      other.label === this.label &&
      other.exists === this.exists
    )
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-wikilink cm-wikilink-${this.kind}${this.exists ? '' : ' cm-wikilink-missing'}`
    el.textContent = this.label
    // The dataset key is what `resolveLinkClick` routes on — a task id must never be
    // read as a vault path.
    el.dataset[this.kind === 'task' ? 'taskTarget' : 'wikiTarget'] = this.target
    return el
  }

  override ignoreEvent(): boolean {
    return false // clicks bubble to the editor's click handler (open target)
  }
}
