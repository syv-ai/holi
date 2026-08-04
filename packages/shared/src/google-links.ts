/**
 * Google links in a note or task body — **detected, never stored** (D67).
 *
 * A linked email or calendar event is an ordinary markdown link in the file's
 * body. There is no frontmatter field, no `related[]`, and nothing machine-owned
 * — which is exactly what keeps "the file is the task" true, and keeps
 * "what references this meeting?" a grep rather than an index.
 *
 * The chip a surface renders beside such a link is therefore a *rendering* of
 * the body, computed here at display time. It is the same argument `labels.ts`
 * makes for `overdue`/`p1`: the moment something writes the chip down, a file
 * rewrite (and an autosave commit) happens for a fact that was already in the
 * text, and the field becomes half machine-owned.
 */

export type GoogleLinkKind = 'mail' | 'calendar'

export interface GoogleLink {
  kind: GoogleLinkKind
  /** The link text as written — the subject or event title, normally. */
  title: string
  url: string
}

/** `[title](url)` — the only form Holi writes, and the only one worth chipping.
 *  A bare URL is left alone: it is not a link the user *named*, and decorating
 *  it would mean rewriting prose the author chose. */
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
 * Duplicates are kept: two links to the same thread in one file is a thing a
 * person can legitimately write, and silently collapsing them would make a
 * rendered body disagree with its source.
 */
export function googleLinksIn(body: string): GoogleLink[] {
  const links: GoogleLink[] = []
  for (const [, title, url] of body.matchAll(MARKDOWN_LINK)) {
    const kind = googleLinkKind(url!)
    if (kind !== null) links.push({ kind, title: title!.trim(), url: url! })
  }
  return links
}
