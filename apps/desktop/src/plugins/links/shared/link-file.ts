/**
 * The link file format: `link.<name>.md`, a web address saved in the vault
 * (docs/features/links.md). Frontmatter holds `url` and, like any note,
 * `tags`; the body is what someone wrote about it.
 *
 * Nothing the page says is stored: the name is the page's title as a file
 * name (`fileSlug`), and the card's title, image and description are
 * fetched live. A file holds only what a person
 * chose, so it never goes stale against the page.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  claimedFiles,
  fileSlug,
  splitFrontmatter,
  type ClaimedFiles,
  type ClaimedItem,
  type FieldSpec,
  type SnapshotClaim,
  type VaultSnapshot,
} from '@holi/shared'
import { hostOf, isWebUrl } from './preview'

/** The filename marker, as tasks have `task.`: the name says what the file
 *  is, so no copied frontmatter can make a note into a link. */
export const LINK_PREFIX = 'link.'

/** The plugin's id, and the key of its files in `snapshot.claimed`. */
export const LINKS_CLAIM = 'links'

/** A link file as the vault holds it. */
export interface LinkItem extends ClaimedItem {
  url: string
  tags: string[]
}

/** Is this file a link? The name decides, and nothing else does. */
export function isLinkFilePath(rel: string): boolean {
  const base = rel.split('/').at(-1) ?? ''
  return base.startsWith(LINK_PREFIX) && base.endsWith('.md') && base.length > 'link..md'.length
}

/** What a link is called where a name is read rather than a file listed (a
 *  wiki-link's chip, the `@` menu): its name without the marker, a private
 *  one's `.local` or `.md`, dashes read as spaces (`link.q3-deck.md` is
 *  "q3 deck"). The card shows the page's own title. */
export function linkTitle(rel: string): string {
  const base = rel.split('/').at(-1) ?? rel
  return base
    .slice(LINK_PREFIX.length)
    .replace(/(\.local)?\.md$/i, '')
    .replace(/-/g, ' ')
}

const NAME_MAX = 80

/** A title as a link's name, by the shared file-name rule (`fileSlug`): lower
 *  case, dashes, æ ø å written out, so `Q3 strategy deck` is
 *  `q3-strategy-deck`. */
export function linkName(title: string): string {
  return fileSlug(title, { max: NAME_MAX, fallback: 'link' })
}

/** The path for a new link titled `title` in `folder` ('' = the vault root).
 *  `n` above 1 is the nth of that name, `title-2`, its number after the name
 *  is cut to length, so it always tells the two apart. */
export function linkFilePath(folder: string, title: string, n = 1): string {
  const name = `${LINK_PREFIX}${linkName(title)}${n > 1 ? `-${n}` : ''}.md`
  return folder === '' ? name : `${folder}/${name}`
}

/** A title for an address whose page names none: its host and path. */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${hostOf(url)}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

/** A new link file's text: its address, and an empty body for what someone
 *  will say about it. The page's own description is the card's to show, so
 *  it is not copied in. */
export function linkFileText(url: string): string {
  return `---\n${stringifyYaml({ url }, { lineWidth: 0 })}---\n`
}

/** A link file's address and tags. Throws, saying why, for a file with no
 *  address or one that is not a web address: the scan reports it as broken
 *  rather than dropping it. */
export function parseLinkFile(text: string, path: string): LinkItem {
  const { yaml } = splitFrontmatter(text)
  const front: unknown = yaml === null ? null : parseYaml(yaml)
  const map =
    front !== null && typeof front === 'object' && !Array.isArray(front)
      ? (front as Record<string, unknown>)
      : {}
  const url = typeof map.url === 'string' ? map.url.trim() : ''
  if (url === '') throw new Error('a link file needs a `url`')
  if (!isWebUrl(url)) throw new Error(`\`url\` must be an http(s) address, not "${url}"`)
  const tags = Array.isArray(map.tags)
    ? map.tags.filter((t): t is string => typeof t === 'string')
    : []
  return { path, url, tags }
}

/** Its frontmatter rows: the address, and a note's tags. */
export const LINK_FIELDS: readonly FieldSpec[] = [
  { key: 'url', kind: { kind: 'text' }, required: true },
  { key: 'tags', kind: { kind: 'list' } },
]

export const linkClaim: SnapshotClaim = {
  match: isLinkFilePath,
  parse: (text, path) => parseLinkFile(text, path),
}

export function snapshotLinks(snapshot: VaultSnapshot): ClaimedFiles<LinkItem> {
  return claimedFiles(snapshot, LINKS_CLAIM) as ClaimedFiles<LinkItem>
}
