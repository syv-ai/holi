/**
 * Search across a vault's notes, for a vault app's `holi.search` and
 * `holi search`: names first, then bodies.
 *
 * A grep, not an index, like `vault/backrefs.ts`: an index is a second copy of
 * the vault that can drift, and a vault is small enough to read on demand.
 * What may be searched is the caller's: a vault app passes `isSearchable`
 * (never the agent surface or any app's `data/`, the same refusals as
 * `docs.read`, or a search would read what a read may not), while Holi's own
 * UI may search everything.
 */
import { readFile } from 'node:fs/promises'
import {
  appBundleOf,
  isAgentSurfacePath,
  isAppDataPath,
  vaultRelPath,
  type DocMeta,
} from '@holi/shared'
import { absPathFor } from '../vault/vault-files'

export interface SearchHit {
  path: string
  match: 'name' | 'body'
  /** For a body match: the text around the first occurrence. */
  snippet?: string
}

export const SEARCH_LIMIT = 50
const SNIPPET_RADIUS = 60

/** What a search may look at: not the agent surface, not any app's records. */
export function isSearchable(path: string): boolean {
  if (isAgentSurfacePath(path)) return false
  const bundle = appBundleOf(path)
  return bundle === null || !isAppDataPath(path.slice(bundle.length + 1))
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS)
  const inner = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${inner}${end < text.length ? '…' : ''}`
}

/** `q` already trimmed and non-empty. Case-insensitive substring match. */
export async function searchVault(
  root: string,
  docs: DocMeta[],
  q: string,
  include: (path: string) => boolean,
): Promise<SearchHit[]> {
  const needle = q.toLowerCase()
  const candidates = docs
    .map((d) => d.path)
    .filter(include)
    .sort((a, b) => a.localeCompare(b))

  const hits: SearchHit[] = []
  const named = new Set<string>()
  for (const path of candidates) {
    if ((path.split('/').at(-1) ?? path).toLowerCase().includes(needle)) {
      hits.push({ path, match: 'name' })
      named.add(path)
      if (hits.length >= SEARCH_LIMIT) return hits
    }
  }
  for (const path of candidates) {
    if (named.has(path)) continue
    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8').catch(() => null)
    if (text === null) continue
    const at = text.toLowerCase().indexOf(needle)
    if (at === -1) continue
    hits.push({ path, match: 'body', snippet: snippetAround(text, at, needle.length) })
    if (hits.length >= SEARCH_LIMIT) break
  }
  return hits
}
