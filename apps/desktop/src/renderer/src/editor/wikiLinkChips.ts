import { WidgetType } from '@codemirror/view'

/**
 * Inline chip for a `[[path]]` / `[[path|Label]]` wiki-link.
 *
 * Every chip routes by path: a claimed file (a task) is a file like any
 * other. `look` is how its claim draws it: an orb before the title, struck
 * when finished. `label` arrives resolved (`|Label`, or the claim's title).
 */
export class WikiLinkChip extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly exists: boolean,
    readonly look?: { orb?: string; struck?: boolean },
  ) {
    super()
  }

  override eq(other: WikiLinkChip): boolean {
    return (
      other.target === this.target &&
      other.label === this.label &&
      other.exists === this.exists &&
      other.look?.orb === this.look?.orb &&
      other.look?.struck === this.look?.struck
    )
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = [
      'cm-wikilink',
      this.look ? 'cm-wikilink-claimed' : 'cm-wikilink-note',
      // A missing tint applies to notes only: a claimed chip resolved from a real file.
      !this.look && !this.exists ? 'cm-wikilink-missing' : '',
      this.look?.struck === true ? 'cm-wikilink-done' : '',
    ]
      .filter(Boolean)
      .join(' ')
    // The dataset key `resolveLinkClick` routes on.
    el.dataset['wikiTarget'] = this.target
    if (this.look?.orb !== undefined) el.appendChild(linkOrb(this.look.orb))
    el.appendChild(document.createTextNode(this.label))
    return el
  }

  override ignoreEvent(): boolean {
    return false // clicks bubble to the editor's click handler (open target)
  }
}

/** The dot a claimed link leads with, in its claim's colour. */
export function linkOrb(colour: string): HTMLElement {
  const orb = document.createElement('span')
  orb.className = 'cm-link-orb'
  orb.style.background = colour
  return orb
}
