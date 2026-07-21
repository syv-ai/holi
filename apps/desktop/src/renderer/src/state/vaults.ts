import { atom } from 'jotai'
import type { DocMeta, Folder, VaultEntry, VaultSnapshot } from '@holi/shared'
import { trpc } from '../lib/trpc'

/** Mirrors the server bus's DocsEvent shape (apps/server/src/bus.ts), the same way
 * vault-manager mirrors TasksEvent — the bus types are server-internal; @holi/shared is
 * the client↔server seam. No vaultId: main filters this to the active vault before it
 * ever reaches the renderer (D52), so the envelope is already unwrapped and spent. */
export type DocsEvent = { type: 'created' | 'renamed' | 'deleted'; doc: DocMeta }

type DocsState = { docs: DocMeta[]; folders: Folder[] }

export const vaultsAtom = atom<VaultEntry[]>([])

/** The open vault, as `owner/repo`. A vault has no id — the remote IS the
 * identity, and the clone's path is machine-local (types.ts §VaultEntry). */
export const activeRemoteAtom = atom<string | null>(null)

const EMPTY_SNAPSHOT: VaultSnapshot = { docs: [], tasks: [], broken: [] }

/**
 * The whole vault, as last read off disk.
 *
 * **One source.** The board, the tree and the editor all derive from this rather
 * than each holding a query of their own — under D60 there is no server pushing
 * per-entity events to keep several caches honest, so a second source would only
 * ever be a second chance to disagree.
 *
 * Refreshed by re-scanning after a write. That is a full walk-and-parse of the
 * vault, and deliberately so: a task set this size is imperceptible to re-read,
 * and the alternative is an index with an invalidation story bought before any
 * measurement asked for one (prd/tasks.md §Summary). The filesystem watcher will
 * replace the explicit refetch, not the shape.
 */
export const snapshotAtom = atom<VaultSnapshot>(EMPTY_SNAPSHOT)

/** The doc open in the editor. */
export const activeDocAtom = atom<DocMeta | null>(null)

export const loadVaultsAtom = atom(null, async (get, set) => {
  const vaults = await trpc.vaults.list.query()
  set(vaultsAtom, vaults)
  const active = get(activeRemoteAtom)
  if (!active && vaults[0]) set(activeRemoteAtom, vaults[0].remote)
})

export const loadSnapshotAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return set(snapshotAtom, EMPTY_SNAPSHOT)
  set(snapshotAtom, await trpc.vaults.snapshot.query({ remote }))
})

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.create.mutate({ remote, path })
  await set(loadSnapshotAtom)
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
})

/** Clears the editor when it is the open note being deleted — otherwise the pane
 * holds a doc that no longer exists. */
export const deleteNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.delete.mutate({ remote, path })
  if (get(activeDocAtom)?.path === path) set(activeDocAtom, null)
  await set(loadSnapshotAtom)
})

// `renameNoteAtom` / `renameFolderAtom` are deliberately absent, exactly as
// `notes.rename` is absent from the router: a rename must move the file AND
// rewrite every inbound `[[wiki-link]]` in one pass, and shipping the move half
// alone would silently break every link. `loadBackrefsAtom` and `createVaultAtom`
// went with the procedures they called — backrefs is a grep now, and creating a
// vault means cloning a GitHub repo (prd/auth-identity.md), not a server insert.

// ------------------------------------------------------------------ reducers
// Pure, exported, and tested directly — the atoms are just where they live.

/**
 * A doc changed somewhere: a teammate, your own agent, another window, or this app in a
 * flow that does not refetch. Until now nothing in the renderer heard about it and the
 * tree simply lied until you switched vaults.
 *
 * Keyed on `doc.id`, never on path — a rename changes the path, which is the entire
 * event. `created` upserts rather than appends: the frame is the newer truth, and a
 * duplicate id renders the same note twice.
 */
export function applyDocsEvent(state: DocsState, event: DocsEvent): DocsState {
  if (event.type === 'deleted') {
    return { ...state, docs: state.docs.filter((d) => d.id !== event.doc.id) }
  }
  const known = state.docs.some((d) => d.id === event.doc.id)
  return {
    ...state,
    docs: known ? state.docs.map((d) => (d.id === event.doc.id ? event.doc : d)) : [...state.docs, event.doc],
  }
}

export interface Backref {
  srcDocId: string
  occurrences: number
}
export interface NamedBackref extends Backref {
  path: string
}

/**
 * Name the notes that link somewhere. `notes.backrefs` returns `srcDocId` and a count —
 * no path, no title — so this joins against the docs we already have.
 *
 * The fallback is not decoration: a link can come from a doc that is not in this list,
 * and this text goes straight into the confirm someone is about to make a delete decision
 * from. Rendering `undefined` there would be worse than not warning at all.
 */
export function namedBackrefs(refs: Backref[], docs: DocMeta[]): NamedBackref[] {
  const byId = new Map(docs.map((d) => [d.id, d.path]))
  return refs.map((r) => ({ ...r, path: byId.get(r.srcDocId) ?? 'a note you cannot see' }))
}

/**
 * Does this doc imply a folder row we do not have?
 *
 * Folder rows have no channel: `DocsEvent` carries a `DocMeta` and the server's
 * `ensureAncestorFolders` writes the rows silently. `buildTree` synthesizes the missing
 * ones with `folderId: null`, so the *tree* renders fine — but `foldersAtom` feeds the
 * board's lanes from real rows, and a synthesized folder has no id to rename by. So on
 * the rare "first note in a new folder", refetch rather than invent a row the server
 * never sent.
 */
export function needsFolderRefetch(state: DocsState, doc: DocMeta): boolean {
  const slash = doc.path.lastIndexOf('/')
  if (slash === -1) return false
  const known = new Set(state.folders.map((f) => f.path))
  const parts = doc.path.slice(0, slash).split('/')
  return parts.some((_, i) => !known.has(parts.slice(0, i + 1).join('/')))
}
