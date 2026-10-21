/**
 * The vault's link scans: what links to a path, for the delete preview and
 * rename, and both directions of one file's links for the links drawer. There
 * is no link index: a grep across the vault's markdown is enough
 * for an interactive one-shot, and it cannot drift out of sync the way an
 * index can (docs/features/wiki-links.md).
 *
 * A note linking to *itself* is not a backref, so the target file is excluded.
 */
import { readFile } from 'node:fs/promises'
import { fileKind, parseWikiLinks, wikiLinksToText } from '@holi/shared'
import { listFiles } from './vault-files'

/** Every markdown file in the vault with its text, in walk order, skipping the
 *  paths `skip` names and any file that cannot be read. The one walk every
 *  scan here makes. */
export async function* markdownFiles(
  root: string,
  skip: (path: string) => boolean = () => false,
): AsyncGenerator<{ path: string; text: string }> {
  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md') || skip(path)) continue
    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text !== null) yield { path, text }
  }
}

/** Files that reference `target`, with how many times each does, sorted by
 *  path so the result is stable and testable. */
export async function scanBackrefs(
  root: string,
  target: string,
): Promise<{ path: string; count: number }[]> {
  return scanBackrefsMany(root, [target])
}

/**
 * Files OUTSIDE `targets` that link INTO the set, with how many such links each
 * has: the delete preview for a folder or multi-selection.
 *
 * Links that ORIGINATE from within the set are excluded: an internal link
 * between two notes being deleted together is not a tombstone anyone is left
 * with, so counting it would over-warn.
 */
export async function scanBackrefsMany(
  root: string,
  targets: string[],
): Promise<{ path: string; count: number }[]> {
  const set = new Set(targets)
  const out: { path: string; count: number }[] = []
  for await (const { path, text } of markdownFiles(root, (p) => set.has(p))) {
    const count = parseWikiLinks(text).filter((link) => set.has(link.target)).length
    if (count > 0) out.push({ path, count })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** A note a file links to, once per target in first-seen order. */
export interface OutgoingLink {
  target: string
  /** The first link's explicit label, if it had one. */
  label?: string
  /** How many times the file links there. */
  count: number
  /** Whether the target is a markdown file in the vault now. */
  exists: boolean
}

/** One line of another file that links to the scanned one. */
export interface Backlink {
  path: string
  /** 1-based. */
  line: number
  /** The line, links read as their text, trimmed and capped. */
  snippet: string
}

const SNIPPET_MAX = 160

/**
 * Both directions of one file's links, in one walk: what it links to, and
 * every line elsewhere that links to it. Only markdown is in the link graph,
 * so a link to an image or any other asset is not an outgoing link; a link to
 * a note that does not exist is, and says so.
 *
 * `path`'s own text is read off disk, so an edit shows once autosave has
 * written it.
 */
export async function scanLinks(
  root: string,
  path: string,
): Promise<{ outgoing: OutgoingLink[]; backlinks: Backlink[] }> {
  const notes = new Set<string>()
  const outgoing = new Map<string, OutgoingLink>()
  const backlinks: Backlink[] = []
  for await (const file of markdownFiles(root)) {
    notes.add(file.path)
    if (file.path === path) {
      for (const link of parseWikiLinks(file.text)) {
        if (fileKind(link.target) !== 'markdown') continue
        const seen = outgoing.get(link.target)
        if (seen) seen.count++
        else
          outgoing.set(link.target, {
            target: link.target,
            ...(link.label !== undefined && { label: link.label }),
            count: 1,
            exists: false,
          })
      }
      continue
    }
    if (!file.text.includes(path)) continue
    file.text.split('\n').forEach((text, i) => {
      if (!parseWikiLinks(text).some((link) => link.target === path)) return
      const plain = wikiLinksToText(text).trim()
      backlinks.push({
        path: file.path,
        line: i + 1,
        snippet: plain.length > SNIPPET_MAX ? `${plain.slice(0, SNIPPET_MAX - 1)}…` : plain,
      })
    })
  }
  for (const link of outgoing.values()) link.exists = notes.has(link.target)
  backlinks.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return { outgoing: [...outgoing.values()], backlinks }
}
