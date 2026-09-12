import { WidgetType } from '@codemirror/view'

/**
 * Inline `<img>` for `![alt](path)` and `[[img.png]]` in live-preview. `src` is
 * already resolved (a `holi-vault://` URL or an external http(s) URL); the widget
 * renders what it is handed and looks nothing up, so `eq` is an honest identity
 * check. A broken/missing file falls back to the browser's native alt text.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  override toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.className = 'cm-image'
    img.style.maxWidth = '100%'
    img.style.maxHeight = '320px'
    img.style.display = 'block'
    // Arrive: an image pops in the moment it decodes, which on a note full of
    // them reads as the page flickering. Fading is PAINT — opacity only — so it
    // costs CodeMirror's measure loop nothing, and `maxWidth`/`maxHeight` above
    // already bound the box, so nothing on the line shifts as it lands.
    img.style.opacity = '0'
    img.style.transition = 'opacity var(--motion-arrive, 300ms) var(--ease-settle, ease-out)'
    const reveal = (): void => {
      img.style.opacity = '1'
    }
    if (img.complete) reveal()
    else img.addEventListener('load', reveal, { once: true })
    // A broken image must not stay invisible: it still has alt text to show.
    img.addEventListener('error', reveal, { once: true })
    img.style.borderRadius = '4px'
    return img
  }

  override ignoreEvent(): boolean {
    return false
  }
}
