import { WidgetType } from '@codemirror/view'
import { COLUMN_MAX_WIDTH } from './theme'

/**
 * Inline `<img>` for `![alt](path)` and `[[img.png]]` in live-preview. `src` is
 * already resolved (a `holi-vault://` URL or an external http(s) URL); the widget
 * renders what it is handed and looks nothing up, so `eq` is an honest identity
 * check. A broken/missing file falls back to the browser's native alt text.
 * `compact` is set in a table cell, where an image stays thumbnail-sized.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly compact = false,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.compact === this.compact
  }

  override toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.className = 'cm-image'
    // Natural size, shrunk to fit the column. The height cap is 70% of the window
    // but never less than the column's widest, so a square figure always reaches
    // the column's width and only a tall portrait one is held to the screen. Width
    // and height stay `auto`, so the aspect ratio holds and a small image is never
    // scaled up.
    img.style.maxWidth = '100%'
    img.style.maxHeight = this.compact ? '320px' : `max(70vh, ${COLUMN_MAX_WIDTH})`
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
