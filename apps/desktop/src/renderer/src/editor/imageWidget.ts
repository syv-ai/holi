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
    // Fade in on decode rather than pop, which flickers on an image-heavy note.
    // Opacity only, so CodeMirror's measure loop is untouched.
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
