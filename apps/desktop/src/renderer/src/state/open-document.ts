/**
 * A request to open a vault document in the shell, from anywhere that is not
 * the shell: a plugin's "open this file" (a chat's review card, a saved
 * reply). The shell owns its tabs, so it answers the request the way it
 * answers `settingsRequestAtom`: it watches this and opens the path as a tab,
 * bringing the Documents side of the sidebar forward.
 */
import { atom } from 'jotai'

/** The last request: its path, numbered so the same path can be asked twice. */
export const openDocumentRequestAtom = atom<{ path: string; seq: number } | null>(null)

/** Open `path` (vault-relative) in the shell. */
export const openDocumentAtom = atom(null, (get, set, path: string) => {
  set(openDocumentRequestAtom, { path, seq: (get(openDocumentRequestAtom)?.seq ?? 0) + 1 })
})
