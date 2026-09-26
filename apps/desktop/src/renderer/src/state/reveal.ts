/**
 * "Show me this file in the explorer."
 *
 * The explorer's expansion, selection and focus are `FileTree`'s own state,
 * which nothing outside the component can reach. So revealing is a request:
 * anywhere writes a path here, and `FileTree` answers.
 *
 * The nonce gives the effect an edge to fire on when the same path is revealed
 * again (click Edit Source twice), which a settled atom value would not.
 *
 * The request is deliberately never cleared. `FileTree` also uses the standing
 * path to keep a hidden file (`.holi/apps/<id>/index.html`) visible while
 * show-hidden is off, or it would vanish from under the selection. One revealed
 * hidden path at a time, so the exception stays bounded.
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
