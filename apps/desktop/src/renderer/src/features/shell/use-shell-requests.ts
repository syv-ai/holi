import { useRequest } from '@/hooks/use-request'
import { openDocumentRequestAtom } from '@/state/open-document'
import { revealInFilesRequestAtom } from '@/state/reveal-in-files'
import { settingsRequestAtom } from '@/state/settings-section'

/**
 * What the rest of the app asks of the shell, which owns the tabs and the
 * sidebar (`state/request.ts`): Settings (⌘,, the profile menu, a plugin's
 * "Open Connections"), a document to open (a chat's changed file, a saved
 * reply), and Reveal in Files (the tree finds the row itself).
 */
export function useShellRequests({
  openSettings,
  openTabKey,
  revealFiles,
}: {
  openSettings: () => void
  openTabKey: (id: string) => void
  /** Bring the Documents side of the sidebar forward, open. */
  revealFiles: () => void
}): void {
  useRequest(settingsRequestAtom, () => openSettings())
  useRequest(openDocumentRequestAtom, ({ path }) => openTabKey(path))
  useRequest(revealInFilesRequestAtom, () => revealFiles())
}
