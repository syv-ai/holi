/** Holi's types for the parts of foliate-js's `view.js` it uses (vendored.md). */
export interface TocItem {
  label: string
  href: string
  subitems?: TocItem[] | null
}

export interface ManifestItem {
  href: string
  mediaType: string
}

export interface Section {
  load(): Promise<string | null | undefined>
  unload(): void
}

export interface Book {
  resources: {
    manifest: ManifestItem[]
    spine: { idref: string }[]
    getItemByID(id: string): ManifestItem | undefined
  }
  sections: (Section | null)[]
  destroy(): void
  toc?: TocItem[]
  metadata?: { title?: string | Record<string, string> }
  rendition?: { layout?: string }
  transformTarget?: EventTarget
}

export interface Relocation {
  fraction: number
  tocItem?: { label?: string; href?: string } | null
}

export function makeBook(file: File): Promise<Book>

export class View extends HTMLElement {
  book: Book
  renderer: HTMLElement & { setStyles?(css: string): void; next(): Promise<void> }
  open(book: Book): Promise<void>
  close(): void
  init(options: { lastLocation?: unknown; showTextStart?: boolean }): Promise<void>
  goTo(target: string | number): Promise<unknown>
  goLeft(): Promise<void>
  goRight(): Promise<void>
}
