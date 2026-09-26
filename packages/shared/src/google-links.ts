/**
 * Google links in a note or task body — **detected, never stored** (D67).
 *
 * A linked email or calendar event is an ordinary markdown link in the file's
 * body, with no frontmatter field, so "what references this meeting?" stays a
 * grep. The chip beside such a link is computed at display time, for the same
 * reason as `labels.ts`: writing it down would rewrite (and commit) a file for
 * a fact already in the text.
 */

export type GoogleLinkKind = 'mail' | 'calendar'

export interface GoogleLink {
  kind: GoogleLinkKind
  /** The link text as written — the subject or event title, normally. */
  title: string
  url: string
}

/** `[title](url)`: the only form Holi writes, and the only one worth chipping.
 *  A bare URL is left alone: it is not a link the user *named*. */
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g

/** Matched on host + path, never on the whole string: a URL mentioning
 *  "calendar.google.com" inside a query parameter of some other host is not a
 *  Google link, and substring matching would claim it. */
export function googleLinkKind(url: string): GoogleLinkKind | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  const host = parsed.hostname.toLowerCase()
  if (host === 'mail.google.com') return 'mail'
  if (host === 'calendar.google.com') return 'calendar'
  return null
}

/**
 * Every Google link in a body, in the order they appear.
 *
 * Duplicates are kept, so a rendered body never disagrees with its source.
 */
export function googleLinksIn(body: string): GoogleLink[] {
  const links: GoogleLink[] = []
  for (const [, title, url] of body.matchAll(MARKDOWN_LINK)) {
    const kind = googleLinkKind(url!)
    if (kind !== null) links.push({ kind, title: title!.trim(), url: url! })
  }
  return links
}
