/**
 * What the Agents mode shows (docs/features/sidebar.md): the agent's own
 * views (its home, the Inbox, History, a live session), or a row another plugin added
 * (its slot). The selection is core's `agentsSelectionAtom`, shared with those
 * plugins; this module reads the agent's part of it.
 *
 * A plugin may select one of the agent's sessions too: `{owner: 'agent', id:
 * 'session:<job id>'}` is the agent's public name for one.
 */
import { atom } from 'jotai'
import { agentsSelectionAtom } from '@/plugin-api'

/** The agent's plugin id: the owner of its own rows. */
const AGENT_OWNER = 'agent'

export type AgentsView =
  | { kind: 'home' }
  /** What needs the person: sessions waiting, and what plugins add. */
  | { kind: 'inbox' }
  /** Every conversation and run, open or closed, by day. */
  | { kind: 'history' }
  /** A live background session, in its terminal. */
  | { kind: 'session'; id: string }
  /** A row another plugin added: its own main view draws it. */
  | { kind: 'slot'; owner: string; id: string }

/** What a selection shows: a tab's own, or the mode's. */
export function agentsViewOf(sel: { owner: string; id: string } | null): AgentsView {
  if (sel === null) return { kind: 'home' }
  if (sel.owner !== AGENT_OWNER) return { kind: 'slot', owner: sel.owner, id: sel.id }
  if (sel.id === 'new') return { kind: 'home' }
  if (sel.id === 'inbox') return { kind: 'inbox' }
  if (sel.id === 'history') return { kind: 'history' }
  const [kind, ...rest] = sel.id.split(':')
  if (kind === 'session') return { kind: 'session', id: rest.join(':') }
  return { kind: 'home' }
}

export const agentsViewAtom = atom(
  (get): AgentsView => agentsViewOf(get(agentsSelectionAtom)),
  (_get, set, view: AgentsView) => {
    // A selection of its own, never null: null may already be the
    // selection (a document in front), and an unchanged selection opens no
    // tab. Core opens the home for any `new` (`keyForSelection`).
    if (view.kind === 'home') set(agentsSelectionAtom, { owner: AGENT_OWNER, id: 'new' })
    else if (view.kind === 'inbox') set(agentsSelectionAtom, { owner: AGENT_OWNER, id: 'inbox' })
    else if (view.kind === 'history')
      set(agentsSelectionAtom, { owner: AGENT_OWNER, id: 'history' })
    else if (view.kind === 'slot') set(agentsSelectionAtom, { owner: view.owner, id: view.id })
    else set(agentsSelectionAtom, { owner: AGENT_OWNER, id: `session:${view.id}` })
  },
)

/** A terminal the Agents view already has for a session (a New session's own
 *  window), so its view shows that one rather than opening another. */
export const viewTerminalsAtom = atom<Record<string, string>>({})
