/**
 * A request to open a vault document in the shell, from anywhere that is not
 * the shell: a plugin's "open this file" (a chat's review card, a saved
 * reply). The shell owns its tabs, so it answers the request the way it
 * answers `settingsRequestAtom`: it answers this and opens the path as a tab,
 * bringing the Documents side of the sidebar forward.
 *
 * A Holi link may name a heading in the document; the document's view lands
 * the caret on it when it opens the path (`pendingHeadingAtom`).
 */
import { atom } from 'jotai'
import { raise, requestAtom } from './request'

/** The last request: its path, numbered so the same path can be asked twice. */
export const openDocumentRequestAtom = requestAtom<{ path: string }>()

/** The heading a document should open at: a link's anchor or words, until
 *  the document's view has landed on it. */
export const pendingHeadingAtom = atom<{ path: string; heading: string } | null>(null)

/** Open `path` (vault-relative) in the shell, at `heading` when given. */
export const openDocumentAtom = atom(null, (get, set, path: string, heading?: string) => {
  set(pendingHeadingAtom, heading === undefined || heading === '' ? null : { path, heading })
  raise(get, set, openDocumentRequestAtom, { path })
})
