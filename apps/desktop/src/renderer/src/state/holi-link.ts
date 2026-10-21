/**
 * Copying a Holi link (docs/features/holi-links.md): the explorer's row menu,
 * and the palette's two commands for the focused note and the heading its
 * caret is on.
 */
import { headingSlug, holiLink, isLocalOnlyPath, isMachineStatePath } from '@holi/shared'
import { atom } from 'jotai'
import { activeTab, workspaceAtom } from './panes'
import { activeRemoteAtom } from './vaults'

/** Whether a path can be linked to: one that syncs. A local file's link would
 *  point at one machine only, and opening one is refused (`parseHoliLink`). */
export function linkable(path: string): boolean {
  return !isLocalOnlyPath(path) && !isMachineStatePath(path)
}

/** The heading the focused editor's caret is on, set by the editor
 *  (`caretHeading`), or null. */
export const caretHeadingAtom = atom<{ path: string; heading: string } | null>(null)

/** The active tab's note, when it can be linked to. */
export const linkableNoteAtom = atom((get): string | null => {
  const tab = activeTab(get(workspaceAtom))
  return tab?.kind === 'note' && linkable(tab.path) ? tab.path : null
})

/** The heading under the caret in the active tab's note, or null. */
export const linkableHeadingAtom = atom((get): string | null => {
  const path = get(linkableNoteAtom)
  const caret = get(caretHeadingAtom)
  return path !== null && caret?.path === path ? caret.heading : null
})

/** Put the link to `path` in the open vault, at `heading` when given, on the
 *  clipboard. */
export const copyHoliLinkAtom = atom(
  null,
  async (get, _set, path: string, heading?: string): Promise<void> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    const link = holiLink(
      heading === undefined ? { remote, path } : { remote, path, heading: headingSlug(heading) },
    )
    await navigator.clipboard.writeText(link)
  },
)
