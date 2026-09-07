/**
 * "Show me this file in the explorer."
 *
 * The explorer's expansion, selection and focus live inside `FileTree`'s
 * headless-tree instance, which nothing outside the component can reach. So
 * revealing is a request rather than a call: anywhere in the app writes a path
 * here, and `FileTree` — the only thing that *can* drive the tree — answers it.
 *
 * The nonce is the whole reason this is not just a path. A settled atom value
 * makes the second reveal of the same file a no-op, and "reveal it again" is the
 * common case: click Edit Source twice, or reveal the file you are already on.
 * Bumping a counter on every request gives the effect an edge to fire on even
 * when the path has not changed.
 *
 * The request is deliberately never cleared. `FileTree` also uses the standing
 * path to keep a hidden file (`.holi/apps/<id>/index.html`) visible in a tree
 * whose show-hidden toggle is off — the row has to survive the reveal that
 * created it, or it would vanish from under the selection. One revealed hidden
 * path at a time: a second reveal replaces the first, which keeps the exception
 * bounded rather than letting the tree silently accumulate hidden rows.
 */
import { atom } from 'jotai'

export interface RevealRequest {
  /** Vault-relative path of the file (or folder) to show. */
  path: string
  /** Bumped per request, so revealing the same path twice fires twice. */
  nonce: number
}

/** The standing request. Read by `FileTree`; written through `revealPathAtom`. */
export const revealRequestAtom = atom<RevealRequest | null>(null)

/** Ask the explorer to expand to, select and scroll to `path`. */
export const revealPathAtom = atom(null, (get, set, path: string) => {
  set(revealRequestAtom, { path, nonce: (get(revealRequestAtom)?.nonce ?? 0) + 1 })
})
