/**
 * A folder's colour in the file tree (docs/features/file-tree.md): a way for
 * one person to find their folders at a glance, per vault, on this machine.
 *
 * **Machine-local, not committed**, as pins are (`state/pins.ts`): how one
 * person marks their folders is not a decision about the vault, so it does
 * not travel with it. Keyed by remote, so each vault keeps its own.
 *
 * A colour names a vault-relative folder path. One whose folder has gone is
 * not shown, and comes back with an undone rename.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { isFolderColour, type FolderColour } from '@/lib/folder-colour'
import { activeRemoteAtom } from './vaults'

export type { FolderColour }

export const folderColoursByVaultAtom = atomWithStorage<
  Record<string, Record<string, FolderColour>>
>('holi:folderColours', {})

/** The open vault's folder colours, by path. Anything stored that is not a
 *  known colour (an older build's, a hand edit) reads as none. */
export const folderColoursAtom = atom((get): Readonly<Record<string, FolderColour>> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return {}
  const mine = get(folderColoursByVaultAtom)[remote] ?? {}
  return Object.fromEntries(Object.entries(mine).filter(([, c]) => isFolderColour(c)))
})

/** Colour a folder in the open vault, or clear it with `null`. */
export const setFolderColourAtom = atom(
  null,
  (get, set, { path, colour }: { path: string; colour: FolderColour | null }): void => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    const all = get(folderColoursByVaultAtom)
    const { [path]: _gone, ...rest } = all[remote] ?? {}
    set(folderColoursByVaultAtom, {
      ...all,
      [remote]: colour === null ? rest : { ...rest, [path]: colour },
    })
  },
)
