// Mail and Calendar use the same recognizers for untrusted prose. Explicit
// links can pass the HTTPS check without qualifying as a conference or event.
function parsedHttps(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const parts = /^https:\/\/([^/?#]+)([^?#]*)/i.exec(text)
  if (!parts) return null
  const [, authority = '', path = ''] = parts
  // Do not normalize a disguised host or dot-segment path into a trusted one.
  if (
    /[@%]/.test(authority) ||
    /[\s\p{Cc}\\]/u.test(text) ||
    /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(path)
  )
    return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && !url.port ? url : null
  } catch {
    return null
  }
}

export function httpsLink(value: unknown): string | null {
  return parsedHttps(value)?.href ?? null
}

function recognizedHttps(value: unknown): URL | null {
  const url = parsedHttps(value)
  if (!url || typeof value !== 'string') return null
  const raw = /^https:\/\/([^/?#]+)([^?#]*)/i.exec(value.trim())
  // Treat escaped separators as unrecognized, not part of an ID.
  if (!raw || raw[2] !== url.pathname || /%(?:2f|5c|25)/i.test(url.pathname)) return null
  return url
}

export function providerConferenceUrl(value: unknown): string | null {
  const url = recognizedHttps(value)
  if (!url) return null
  const { hostname, pathname } = url
  let recognized = false
  if (hostname === 'meet.google.com') {
    recognized = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(pathname)
  } else if (hostname === 'teams.microsoft.com' || hostname === 'teams.microsoft.us') {
    recognized = /^\/l\/meetup-join\/(?:[\w:@.-]|%[a-f\d]{2})+\/\d+\/?$/i.test(pathname)
  } else if (hostname === 'teams.live.com') {
    recognized = /^\/meet\/\d+\/?$/.test(pathname)
  } else if (/^(?:[a-z\d-]+\.)*zoom\.us$/.test(hostname)) {
    recognized = /^\/(?:(?:j|w)\/\d+|my\/[\w.-]+)\/?$/.test(pathname)
  }
  return recognized ? url.href : null
}

/** Scans plain text or an HTML description without treating either as markup. */
export function conferenceUrlIn(text: string | null | undefined): string | null {
  for (const [, candidate] of text?.matchAll(/(?:^|[\s"'<>=([{])(https:\/\/[^\s"'<>]+)/gi) ?? []) {
    const link = providerConferenceUrl(
      candidate?.replace(/&amp;/gi, '&').replace(/[.,;:)\]}]+$/, ''),
    )
    if (link) return link
  }
  return null
}

export function googleEventUrl(value: unknown): string | null {
  const url = recognizedHttps(value)
  if (
    !url ||
    url.hostname !== 'calendar.google.com' ||
    !/^\/(?:calendar\/(?:u\/\d+\/)?)?(?:event|eventedit)$/.test(url.pathname)
  )
    return null
  const ids = url.searchParams.getAll('eid')
  return ids.length === 1 && /^[\w-]+=*$/.test(ids[0]!) ? url.href : null
}
