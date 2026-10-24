/**
 * The icon a sender's row shows in place of initials: the site icon of the
 * domain they write from, from Google's favicon service.
 *
 * Only the domain leaves the machine, and only to Google, who already holds
 * the mail; the sender's own server is never asked, so a row cannot tell
 * anyone it was looked at. Personal mail providers keep the initials: their
 * icon would say only "Gmail" for everyone who uses it.
 */

/** Domains whose icon is the mail provider's, not the sender's. */
const PERSONAL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "hey.com",
  "gmx.com",
  "gmx.net",
  "fastmail.com",
])

/** Second-level labels that sit under a country code, as in `co.uk`. */
const UNDER_COUNTRY = new Set(["co", "com", "org", "net", "ac", "gov", "edu"])

/** The site a mail domain belongs to: `notifications.github.com` is
 *  `github.com`, `mail.bbc.co.uk` is `bbc.co.uk`. Close enough for an icon. */
export function siteOf(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean)
  if (labels.length <= 2) return labels.join(".")
  const tld = labels[labels.length - 1]!
  const second = labels[labels.length - 2]!
  const keep = tld.length === 2 && UNDER_COUNTRY.has(second) ? 3 : 2
  return labels.slice(-keep).join(".")
}

/** The icon URL for an address, or null where initials say more. */
export function senderIconUrl(email: string): string | null {
  const at = email.lastIndexOf("@")
  if (at < 0) return null
  const site = siteOf(email.slice(at + 1))
  if (!site.includes(".") || PERSONAL.has(site)) return null
  // faviconV2 answers 404 when a site has no icon, so the initials stay.
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=64&url=${encodeURIComponent(`https://${site}`)}`
}
