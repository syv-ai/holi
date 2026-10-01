/**
 * Directories that are one document (a claim's `folder`, such as a vault
 * app's bundle), and what a surface is called for one of its tabs
 * (docs/features/tabs-panes.md). Pure, over the claims and what the vault
 * holds, so the tree, the panes, Home and the tests share one answer.
 */
import type { FolderClaim, PathClaim, Surface } from '@/plugin-api/types'
import type { Tab } from '@/state/panes'

/** What a surface is called, for its tab `id` or for the surface itself. */
export function surfaceLabel(surface: Surface, id?: string): string {
  return typeof surface.label === 'function' ? surface.label(id) : surface.label
}

/** The claims that make directories documents, with their claim. */
export interface FolderDocumentClaim {
  claim: PathClaim
  folder: FolderClaim
}

export function folderClaims(claims: readonly PathClaim[]): FolderDocumentClaim[] {
  return claims.flatMap((claim) =>
    claim.folder === undefined ? [] : [{ claim, folder: claim.folder }],
  )
}

/** The directory at `path` as a document, or null when it is not one: no
 *  folder claim matches it, or its entry file is not there. */
export function folderDocumentAt(
  claims: readonly FolderDocumentClaim[],
  path: string,
  has: (path: string) => boolean,
): (FolderDocumentClaim & { ready: boolean }) | null {
  for (const c of claims) {
    if (!c.claim.match(path) || !has(`${path}/${c.folder.entry}`)) continue
    return { ...c, ready: c.folder.ready?.(path, has) ?? true }
  }
  return null
}

/** The tab a vault path opens as: a folder document's surface, or a note. */
export function tabForPath(
  claims: readonly FolderDocumentClaim[],
  path: string,
  has: (path: string) => boolean,
): Tab {
  const doc = folderDocumentAt(claims, path, has)
  return doc === null
    ? { kind: 'note', path }
    : { kind: 'surface', surface: doc.folder.surface, id: path }
}

/** The vault path a tab shows: a note's, or a folder document's id. */
export function pathOfTab(claims: readonly FolderDocumentClaim[], tab: Tab | null): string | null {
  if (tab === null) return null
  if (tab.kind === 'note') return tab.path
  if (tab.kind !== 'surface' || tab.id === undefined) return null
  return claims.some((c) => c.folder.surface === tab.surface) ? tab.id : null
}
