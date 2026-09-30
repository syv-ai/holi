/**
 * Links written without markdown: `github.com`, `www.example.com`,
 * `https://…`. They open like a markdown link (⌘/Ctrl-click) and the file is
 * left as it is.
 *
 * `linkify-it` does the matching: the domain grammar, the TLD list, and where
 * a link ends before sentence punctuation are its problem, not a regex's.
 */
import { LinkifyIt } from 'linkify-it'

/**
 * Country domains that are also source-file extensions. In a vault `notes.md`
 * and `main.py` are file names far more often than sites, and a site on one of
 * these can still be written with its `https://`.
 */
const FILE_EXTENSIONS = new Set([
  'md',
  'py',
  'sh',
  'rs',
  'pl',
  'pm',
  'so',
  'mk',
  'ml',
  'ps',
  'tf',
  'cc',
  'mm',
  'gs',
])

/** Newer top-level domains a bare link commonly uses, beyond linkify-it's
 *  default of the classic ones plus every country domain. */
const NEWER_TLDS = ['app', 'dev', 'cloud', 'xyz', 'page', 'blog', 'tech', 'site', 'online']

// Off by default in linkify-it: schemeless links, which are the point, and
// emails, which would open as vault paths.
const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: false })
// `re.opts.tlds` is the default list: the classic domains and every country's.
linkify.tlds(
  [...(linkify.re.opts.tlds ?? []), ...NEWER_TLDS].filter((tld) => !FILE_EXTENSIONS.has(tld)),
)

/** A link found in text: its range in that text, and where it goes. */
export interface BareLink {
  from: number
  to: number
  url: string
}

/** Every bare link in `text`. A link written without a scheme opens over https. */
export function bareLinks(text: string): BareLink[] {
  return (linkify.match(text) ?? []).map((m) => ({
    from: m.index,
    to: m.lastIndex,
    url: m.schema === '' ? `https://${m.raw}` : m.url,
  }))
}
