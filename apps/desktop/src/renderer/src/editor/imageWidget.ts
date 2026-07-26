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
    img.style.borderRadius = '4px'
    return img
  }

  override ignoreEvent(): boolean {
    return false
  }
}
