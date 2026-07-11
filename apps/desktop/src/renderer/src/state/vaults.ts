import { atom } from 'jotai'
import type { DocMeta, Folder, Vault } from '@holi/shared'
import { trpc } from '../lib/trpc'

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
  await set(loadDocsAtom) // refetch (no subscriptions this phase — plan decision #5)
  set(activeDocAtom, doc)
})

export const createVaultAtom = atom(null, async (_get, set, name: string) => {
  const vault = await trpc.vaults.create.mutate({ name, kind: 'shared' })
  await set(loadVaultsAtom)
  set(activeVaultIdAtom, vault.id)
})
