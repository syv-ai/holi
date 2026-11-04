/**
 * The file tree's order, per vault, on this machine (`lib/tree-order.ts`,
 * docs/features/file-tree.md). Machine-local like pins: how one person
 * arranges the tree is not a decision about the vault, and a kept order never
 * conflicts with a teammate's.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { activeRemoteAtom } from './vaults'

/** Remote → folder path ('' for the root) → its children's ids, in order. */
const treeOrderByVaultAtom = atomWithStorage<Record<string, Record<string, string[]>>>(
  'holi:treeOrder',
  {},
)

/** The open vault's orders. */
export const treeOrderAtom = atom((get): Record<string, string[]> => {
  const remote = get(activeRemoteAtom)
  return remote === null ? {} : (get(treeOrderByVaultAtom)[remote] ?? {})
})

/** Keep `children` as `folder`'s order in the open vault. */
export const setTreeOrderAtom = atom(null, (get, set, folder: string, children: string[]) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const all = get(treeOrderByVaultAtom)
  set(treeOrderByVaultAtom, { ...all, [remote]: { ...all[remote], [folder]: children } })
})
