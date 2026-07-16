import { atom } from 'jotai'
import type { DocMeta, Folder, Vault } from '@holi/shared'
import { trpc } from '../lib/trpc'

/** Mirrors the server bus's DocsEvent shape (apps/server/src/bus.ts), the same way
 * vault-manager mirrors TasksEvent — the bus types are server-internal; @holi/shared is
 * the client↔server seam. No vaultId: main filters this to the active vault before it
 * ever reaches the renderer (D52), so the envelope is already unwrapped and spent. */
export type DocsEvent = { type: 'created' | 'renamed' | 'deleted'; doc: DocMeta }

type DocsState = { docs: DocMeta[]; folders: Folder[] }

export const vaultsAtom = atom<Vault[]>([])
export const activeVaultIdAtom = atom<string | null>(null)
export const docsAtom = atom<{ docs: DocMeta[]; folders: Folder[] }>({ docs: [], folders: [] })
/** The doc open in the editor. */
export const activeDocAtom = atom<DocMeta | null>(null)

export const loadVaultsAtom = atom(null, async (get, set) => {
  const vaults = await trpc.vaults.list.query()
  set(vaultsAtom, vaults)
  const active = get(activeVaultIdAtom)
  if (!active && vaults[0]) set(activeVaultIdAtom, vaults[0].id)
})

export const loadDocsAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  set(docsAtom, await trpc.vaults.listDocs.query({ vaultId }))
})

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  const doc = await trpc.notes.create.mutate({ vaultId, path, kind: 'note' })
  // Applied straight away rather than refetched — the `docs:event` echo of this same
  // create upserts by id, so the two agree instead of racing. (This used to refetch,
  // with a comment saying there were no subscriptions in this phase. There are now.)
  set(applyDocsEventAtom, { type: 'created', doc })
  set(activeDocAtom, doc)
})

/**
 * Rename is also **move**: a new path with a different folder prefix relocates the note,
 * and the server's `ensureAncestorFolders` makes the destination folders exist. The
 * server rewrites every `[[link]]` that pointed at the old path, atomically — the same
 * guarantee the agent has had via MCP since the drawer shipped, and the reason this must
 * never be done by hand as a delete-and-recreate.
 *
 * None of these refetch: `docs:event` carries `renamed`/`deleted` back live, and two
 * mechanisms updating the tree is worse than either.
 */
export const renameNoteAtom = atom(null, async (get, _set, docId: string, newPath: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.notes.rename.mutate({ vaultId, docId, newPath })
})

export const renameFolderAtom = atom(null, async (get, _set, folderId: string, newPath: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.notes.renameFolder.mutate({ vaultId, folderId, newPath })
})

/** Clears the editor when it is the open note being deleted — otherwise the pane holds a
 * doc that no longer exists, on a relay room for a doc that is gone. */
export const deleteNoteAtom = atom(null, async (get, set, docId: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.notes.delete.mutate({ vaultId, docId })
  if (get(activeDocAtom)?.id === docId) set(activeDocAtom, null)
})

/** What links here — surfaced BEFORE a delete (FR-12). Built and uncalled until now. */
export const loadBackrefsAtom = atom(null, async (get, _set, path: string): Promise<NamedBackref[]> => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return []
  const refs = (await trpc.notes.backrefs.query({ vaultId, path })) as Backref[]
  return namedBackrefs(refs, get(docsAtom).docs)
})

/** The one place a `docs:event` lands, live or echoed from our own mutation. */
export const applyDocsEventAtom = atom(null, (get, set, event: DocsEvent) => {
  const before = get(docsAtom)
  set(docsAtom, applyDocsEvent(before, event))
  if (event.type !== 'deleted' && needsFolderRefetch(before, event.doc)) void set(loadDocsAtom)
})

export const createVaultAtom = atom(null, async (_get, set, name: string) => {
  const vault = await trpc.vaults.create.mutate({ name, kind: 'shared' })
  await set(loadVaultsAtom)
  set(activeVaultIdAtom, vault.id)
})

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
