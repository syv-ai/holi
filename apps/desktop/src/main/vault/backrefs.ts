/**
 * The vault's link scans: what links to a path, for the delete preview and
 * rename. There is no link index: a grep across the vault's markdown is enough
 * for an interactive one-shot, and it cannot drift out of sync the way an
 * index can (docs/features/wiki-links.md).
 *
 * A note linking to *itself* is not a backref, so the target file is excluded.
 */
import { readFile } from 'node:fs/promises'
import { parseWikiLinks } from '@holi/shared'
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
