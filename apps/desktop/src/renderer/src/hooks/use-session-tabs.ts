import { useAtom, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'

import { agentsSelectionAtom, type AgentsSelection } from '@/state/agents-slots'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { openingBeside } from '@/state/alt-open'
import { openInSplit, openTab } from '@/state/shell-workspace'
import { AGENTS_HOME_KEY, parseTabKey, sessionKey } from '@/state/tab-descriptor'

/** What a selection opens: its session's tab, or for none (or a slot's
 *  `new`, the new-session composer) the Agents home. */
function keyForSelection(selection: AgentsSelection | null): string {
  return selection === null || selection.id === 'new' ? AGENTS_HOME_KEY : sessionKey(selection)
}

/** What the focused tab selects: its session, or nothing. */
function selectionForKey(key: string | null): AgentsSelection | null {
  const tab = key === null ? null : parseTabKey(key)
  return tab?.kind === 'session' ? { owner: tab.owner, id: tab.id } : null
}

/** A tab a session may take the place of: a New tab, or the Agents home a
 *  new chat was started from. */
function replaceable(key: string): boolean {
  const kind = parseTabKey(key)?.kind
  return kind === 'new' || kind === 'agents-home'
}

/**
 * Agent sessions as tabs (docs/features/sidebar.md, Agents opens tabs). The
 * Agents mode's selection (`agentsSelectionAtom`) is what its sidebar and
 * plugins speak: a row picked, a chat started, an Inbox card. Two ways, kept
 * in step:
 *
 * - a selection made anywhere but here opens its tab, or focuses it where it
 *   is; from the Agents home or a New tab it takes that tab's place;
 * - the focused tab writes the selection back, so the sidebar marks the
 *   session in front, and a row picked again after looking elsewhere is a
 *   change the first rule hears.
 *
 * The selection this hook last wrote is remembered, so its own writes open
 * nothing.
 */
export function useSessionTabs(focusedKey: string | null): void {
  const [selection, setSelection] = useAtom(agentsSelectionAtom)
  const setWorkspace = useSetAtom(shellWorkspaceAtom)
  const wrote = useRef<AgentsSelection | null>(selection)

  useEffect(() => {
    if (selection === wrote.current) return
    wrote.current = selection
    const key = keyForSelection(selection)
    // ⌥ on the row that made the selection opens it beside what is in front.
    const beside = openingBeside()
    setWorkspace((ws) => (beside ? openInSplit(ws, key) : openTab(ws, key, replaceable)))
  }, [selection, setWorkspace])

  useEffect(() => {
    const next = selectionForKey(focusedKey)
    const current = wrote.current
    const same =
      next === null
        ? current === null
        : current !== null && current.owner === next.owner && current.id === next.id
    if (same) return
    wrote.current = next
    setSelection(next)
  }, [focusedKey, setSelection])
}
