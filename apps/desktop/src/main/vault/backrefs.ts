/**
 * The single inbound-link scan.
 *
 * Both `notes.backrefs` (the delete preview, FR-12) and `notes.rename` (finding
 * which files to rewrite, FR-11) consume this. There is no link index — a grep
 * across the vault's markdown is enough for an interactive one-shot, and it
 * cannot drift out of sync with the files the way an index can.
 *
 * A note linking to *itself* is not a backref to preview or rewrite, so the
 * target file is excluded. Task chips (`[[task:<id>]]`) are a different grammar
 * and never match a note path.
 */
import { readFile } from 'node:fs/promises'
import { parseWikiLinks } from '@holi/shared'
import { listFiles } from './vault-files'

/** Files that reference `target`, with how many times each does — sorted by
 *  path so the result is stable and testable. */
export async function scanBackrefs(
  root: string,
  target: string,
): Promise<{ path: string; count: number }[]> {
  const out: { path: string; count: number }[] = []
  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md') || path === target) continue
    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text === null) continue
    const count = parseWikiLinks(text).filter(
      (link) => link.kind === 'note' && link.target === target,
    ).length
    if (count > 0) out.push({ path, count })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Files OUTSIDE `targets` that link INTO the set, with how many such links each
 * has — the delete preview for a folder or multi-selection (FR-12 generalized).
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
  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md') || set.has(path)) continue
    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text === null) continue
    const count = parseWikiLinks(text).filter(
      (link) => link.kind === 'note' && set.has(link.target),
    ).length
    if (count > 0) out.push({ path, count })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
