/** Whole-entry close decisions for the shell's user-initiated close actions. */
import type { createStore } from 'jotai'
import { saveBeforeClosing } from '@/lib/buffer-registry'
import { activeRemoteAtom } from './vaults'
import { shellWorkspaceAtom } from './shell-tabs'
import {
  closeAllTabs,
  closeEntry,
  closeOtherTabs,
  closeTabsToRight,
  entryId,
  isSplit,
  type ShellWorkspace,
} from './shell-workspace'

export type EntryCloseRequest =
  | { kind: 'entry'; id: string }
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
  if (!current()) return
  await saveBeforeClosing(() => {
    if (!current()) return
    store.set(shellWorkspaceAtom, (ws) => confirmEntryClose(ws, intent.workspace, intent.request))
  })
}

/** The workspace resulting from the requested whole-entry close.
 * @public Kept for reducer tests.
 */
export function applyEntryClose(ws: ShellWorkspace, request: EntryCloseRequest): ShellWorkspace {
  switch (request.kind) {
    case 'entry':
      return closeEntry(ws, request.id)
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
  const targetIds = new Set(
    request.kind === 'entry'
      ? [request.id]
      : ws.entries
          .filter((entry) => {
            const id = entryId(entry)
            if (request.kind === 'all') return true
            const index = ws.entries.findIndex((item) => entryId(item) === id)
            const anchor = ws.entries.findIndex((item) => entryId(item) === request.id)
            return request.kind === 'others' ? id !== request.id : index > anchor
          })
          .map(entryId),
  )
  return ws.entries.some((entry) => targetIds.has(entryId(entry)) && isSplit(entry))
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
