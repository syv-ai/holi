/** Whole-entry close decisions for the shell's user-initiated close actions. */
import type { createStore } from 'jotai'
import { saveBeforeClosing } from '@/lib/buffer-registry'
import { activeRemoteAtom } from './vaults'
import { shellWorkspaceAtom } from './shell-tabs'
import {
  closeAllTabs,
  closeEntry,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
  entryId,
  isSplit,
  type ShellWorkspace,
} from './shell-workspace'

export type EntryCloseRequest =
  | { kind: 'entry'; id: string; explicit?: boolean }
  | { kind: 'member'; id: string; explicit?: boolean }
  | { kind: 'others'; id: string }
  | { kind: 'right'; id: string }
  | { kind: 'all' }

export interface EntryCloseIntent {
  remote: string | null
  workspace: ShellWorkspace
  request: EntryCloseRequest
}

/** Save before closing only the unchanged workspace the person approved. */
export async function saveEntryClose(
  store: ReturnType<typeof createStore>,
  intent: EntryCloseIntent,
): Promise<void> {
  const current = () =>
    store.get(activeRemoteAtom) === intent.remote &&
    store.get(shellWorkspaceAtom) === intent.workspace
  if (!current() || applyEntryClose(intent.workspace, intent.request) === intent.workspace) return
  await saveBeforeClosing(() => {
    if (!current()) return
    store.set(shellWorkspaceAtom, (ws) => confirmEntryClose(ws, intent.workspace, intent.request))
  }, true)
}

/** The workspace resulting from the requested whole-entry close.
 * @public Kept for reducer tests.
 */
export function applyEntryClose(ws: ShellWorkspace, request: EntryCloseRequest): ShellWorkspace {
  switch (request.kind) {
    case 'entry':
      return closeEntry(ws, request.id, request.explicit)
    case 'member':
      return closeTab(ws, request.id, request.explicit)
    case 'others':
      return closeOtherTabs(ws, request.id)
    case 'right':
      return closeTabsToRight(ws, request.id)
    case 'all':
      return closeAllTabs(ws)
  }
}

/** Whether the request removes at least one split entry. */
export function closesSplit(ws: ShellWorkspace, request: EntryCloseRequest): boolean {
  const remaining = new Set(applyEntryClose(ws, request).entries.map(entryId))
  return (
    request.kind !== 'member' &&
    ws.entries.some((entry) => isSplit(entry) && !remaining.has(entryId(entry)))
  )
}

/** Confirmation is valid only for the unchanged workspace captured at request time.
 * @public Kept for reducer tests.
 */
export function confirmEntryClose(
  current: ShellWorkspace,
  captured: ShellWorkspace,
  request: EntryCloseRequest,
): ShellWorkspace {
  return current === captured ? applyEntryClose(current, request) : current
}
