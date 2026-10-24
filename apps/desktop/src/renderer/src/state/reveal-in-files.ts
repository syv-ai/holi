/**
 * Reveal in Files (docs/features/file-tree.md): show a vault path's row in
 * the files tree, from somewhere that is not the tree, such as an app's card
 * on the Apps page. The shell brings the Documents sidebar forward; the tree
 * opens the row's folders, selects it and scrolls it into view. A request
 * with a sequence number, so asking twice for one path reveals it twice.
 */
import { atom } from 'jotai'

export const revealInFilesRequestAtom = atom<{ path: string; seq: number } | null>(null)

/** Reveal `path` (vault-relative) in the files tree. */
export const revealInFilesAtom = atom(null, (get, set, path: string) => {
  set(revealInFilesRequestAtom, {
    path,
    seq: (get(revealInFilesRequestAtom)?.seq ?? 0) + 1,
  })
})
