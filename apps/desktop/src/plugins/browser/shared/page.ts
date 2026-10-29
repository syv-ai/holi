/**
 * One browser tab as both sides see it (docs/features/browser.md), and the
 * rules for what a tab may show.
 *
 * Pure and browser-safe: main and the renderer read the same rules.
 */

/** Why a page did not load, as Chromium said it. */
export interface PageError {
  code: number
  description: string
  url: string
}

/** One tab, as main last saw it. */
export interface PageInfo {
  id: string
  /** Empty for a tab that has shown nothing yet. */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The site's icon, as the page names it. */
  favicon: string | null
  error: PageError | null
}

/** A page as the agent reads it (`holi browser read`). */
export interface PageRead {
  id: string
  url: string
  title: string
  /** Its text, each control numbered (`[3] button "Sign in"`). */
  text: string
  /** The text was cut at the limit: scroll and read again for the rest. */
  truncated: boolean
}

/** Where to scroll (`holi browser scroll`). */
export type ScrollTo = 'down' | 'up' | 'top' | 'bottom'
export const SCROLL_TO: readonly ScrollTo[] = ['down', 'up', 'top', 'bottom']

/** The search a typed phrase that is not an address goes to. */
const SEARCH = 'https://duckduckgo.com/?q='

/** Whether a tab may show `url`: the web, and the blank page. Anything else
 *  (`file:`, Holi's own schemes, `javascript:`) is refused. */
export function isPageUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * What a typed address means: a web address as it is, a bare host
 * (`example.com`, `localhost:3000`) over https (http for this machine), and
 * anything else a search. Null for nothing typed, or a scheme a tab may not
 * show.
 */
export function addressFor(typed: string): string | null {
  const text = typed.trim()
  if (text === '') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|javascript|data|file):/i.test(text)) {
    return isPageUrl(text) ? text : null
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)
  if (local) return `http://${text}`
  const host = /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text) && !/\s/.test(text)
  if (host) return `https://${text}`
  return SEARCH + encodeURIComponent(text)
}

/** A page's name for its tab: its title, else its host, else "New Tab". */
export function pageLabel(page: Pick<PageInfo, 'title' | 'url'>): string {
  if (page.title.trim() !== '') return page.title.trim()
  try {
    const { host } = new URL(page.url)
    if (host !== '') return host.replace(/^www\./, '')
  } catch {
    // No address yet.
  }
  return 'New Tab'
}
