/** Whole-entry close decisions for the shell's user-initiated close actions. */
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

/** The workspace resulting from the requested whole-entry close. */
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

/** Confirmation is valid only for the unchanged workspace captured at request time. */
export function confirmEntryClose(
  current: ShellWorkspace,
  captured: ShellWorkspace,
  request: EntryCloseRequest,
): ShellWorkspace {
  return current === captured ? applyEntryClose(current, request) : current
}
