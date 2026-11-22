/**
 * A Holi link: `holi://open?vault=owner/repo&path=notes/plan.md&heading=next-steps`.
 *
 * What a teammate pastes in chat or email to point at a note (docs/features/holi-links.md).
 * The vault is named by its remote, the one identity every machine shares, and
 * the file by its vault path; the clone's location on disk is never in a link.
 *
 * A link arrives from outside the app, so `parseHoliLink` treats it as
 * untrusted: it checks the shape and nothing else. Whether this machine has
 * the vault, and the file, is main's question.
 */
import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isMachineStatePath,
  isRemote,
  vaultRelPath,
} from './path-safety'

export const HOLI_LINK_SCHEME = 'holi'
export const HOLI_LINK_WEB_BASE = 'https://syv-ai.github.io/holi/'

export interface HoliLink {
  /** The vault, `owner/repo`. */
  remote: string
  /** The file, vault-relative and normalized. */
  path: string
  /** A heading to scroll to: its GitHub anchor (`next-steps-q3`, `notes-1` for
   *  the second `Notes`), or its words (`findHeadingLine`). */
  heading?: string
}

/** A heading parameter longer than this is not a heading anyone wrote. */
const MAX_HEADING = 200

/** `encodeURIComponent`, but a `/` stays a `/`: a query may hold one, and a
 *  path that reads as a path is a link a person can check by eye. */
const encode = (value: string): string => encodeURIComponent(value).replace(/%2F/g, '/')

/** One spelling of a name: `é` typed as one code point or as `e` and an
 *  accent are the same letter, and a link must not depend on which a keyboard,
 *  a filesystem or a chat app chose. NFC, the form git on macOS writes. */
const nfc = (value: string): string => value.normalize('NFC')

/**
 * Whether `path` can have a link a teammate's Holi will open: not a local
 * file or machine state, which never sync, nor something in a folder the
 * vault never walks. The same rule `parseHoliLink` refuses by.
 */
export function isHoliLinkable(path: string): boolean {
  return !isLocalOnlyPath(path) && !isMachineStatePath(path) && !isInIgnoredDir(path)
}

/** The link to `path` in `remote`, and to `heading` in it when given. */
function payload({ remote, path, heading }: HoliLink): string {
  const query = [`vault=${encode(remote)}`, `path=${encode(nfc(path))}`]
  if (heading !== undefined && heading !== '') query.push(`heading=${encode(nfc(heading))}`)
  return query.join('&')
}

/** The legacy app link retained for OS protocol handlers and internal handoff. */
export function holiLink(link: HoliLink): string {
  return `${HOLI_LINK_SCHEME}://open?${payload(link)}`
}

/** Clickable static Pages URL; destination data stays in the fragment. */
export function holiWebLink(link: HoliLink): string {
  return `${HOLI_LINK_WEB_BASE}#${payload(link)}`
}

export type ParsedHoliLink = { ok: true; link: HoliLink } | { ok: false; reason: string }

/** Read a link from outside. A refusal's `reason` is a sentence for the person
 *  who clicked it. */
export function parseHoliLink(raw: string): ParsedHoliLink {
  const refuse = (reason: string): ParsedHoliLink => ({ ok: false, reason })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refuse('This is not a Holi link.')
  }
  let params: URLSearchParams
  try {
    decodeURIComponent(url.protocol === `${HOLI_LINK_SCHEME}:` ? url.search : url.hash)
  } catch {
    return refuse('The link is not encoded correctly.')
  }
  if (url.protocol === `${HOLI_LINK_SCHEME}:` && url.hostname === 'open') {
    if (url.pathname !== '' && url.pathname !== '/')
      return refuse('Holi does not know this kind of link.')
    if (url.hash !== '') return refuse('Holi does not know this kind of link.')
    params = url.searchParams
  } else if (
    url.protocol === 'https:' &&
    url.origin === 'https://syv-ai.github.io' &&
    url.pathname === '/holi/' &&
    url.search === '' &&
    url.username === '' &&
    url.password === ''
  ) {
    if (!url.hash.startsWith('#') || url.hash.length < 2)
      return refuse('The link does not name a vault.')
    if (/%(?![0-9a-f]{2})/i.test(url.hash)) return refuse('The link is not encoded correctly.')
    params = new URLSearchParams(url.hash.slice(1))
  } else {
    return refuse('Holi does not know this kind of link.')
  }
  const keys = [...params.keys()]
  if (keys.some((key) => !['vault', 'path', 'heading'].includes(key)))
    return refuse('Holi does not know this kind of link.')
  if (['vault', 'path', 'heading'].some((key) => params.getAll(key).length > 1))
    return refuse('The link repeats a destination value.')
  const remote = params.get('vault') ?? ''
  if (!isRemote(remote)) return refuse('The link does not name a vault.')
  let path: string
  try {
    path = vaultRelPath(nfc(params.get('path') ?? ''))
  } catch {
    return refuse('The link does not name a file in the vault.')
  }
  // A local file never syncs, so a teammate's link to one can only point at
  // their own machine; and machine state is Holi's, not something to show.
  if (isLocalOnlyPath(path) || isMachineStatePath(path)) {
    return refuse('The link points at a file that stays on one machine, so it cannot be shared.')
  }
  // Git's own files and installed packages are not vault content at all.
  if (isInIgnoredDir(path)) return refuse('The link does not name a file in the vault.')
  const heading = nfc(params.get('heading') ?? '').trim()
  if (heading.length > MAX_HEADING) return refuse('The link names a heading Holi cannot read.')
  return { ok: true, link: heading === '' ? { remote, path } : { remote, path, heading } }
}

/** The first Holi link among a process's arguments: how Windows and Linux
 *  hand a clicked link to the app, at launch and to the running instance. */
export function holiLinkInArgv(argv: readonly string[]): string | null {
  // A scheme is case-insensitive: `HOLI://open?…` is the same link.
  const prefix = `${HOLI_LINK_SCHEME}://`
  return argv.find((arg) => arg.slice(0, prefix.length).toLowerCase() === prefix) ?? null
}
