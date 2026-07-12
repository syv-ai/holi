import { WidgetType } from '@codemirror/view'

/** Inline chip for [[path]] / [[path|Label]] (notes-editor PRD FR-6, core set). */
export class WikiLinkChip extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string | undefined,
    readonly exists: boolean,
  ) {
    super()
  }

  override eq(other: WikiLinkChip): boolean {
    return other.target === this.target && other.label === this.label && other.exists === this.exists
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-wikilink${this.exists ? '' : ' cm-wikilink-missing'}`
    el.textContent = this.label ?? this.target
    el.dataset['wikiTarget'] = this.target
    return el
  }

  override ignoreEvent(): boolean {
    return false // clicks bubble to the editor's click handler (open target)
  }
}
