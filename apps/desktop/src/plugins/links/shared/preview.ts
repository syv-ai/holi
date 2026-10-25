/** What a web page says about itself, as a link's card shows it
 *  (docs/features/links.md). Everything but `url` may be missing: a page
 *  behind a login says nothing, and its card is the address alone. */
export interface LinkPreview {
  /** The address asked about. */
  url: string
  title?: string
  description?: string
  /** An image's address, absolute. */
  image?: string
  /** The site's name, or its host when it gives none. */
  siteName?: string
  /** The favicon's address, absolute. */
  icon?: string
}

/** Whether `s` is an address Holi fetches and opens: http or https, and
 *  nothing else. Main holds every fetch to it again. */
export function isWebUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false
  try {
    new URL(s)
    return true
  } catch {
    return false
  }
}

/** The host of a web address without its `www.`, or the address itself when
 *  it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}
