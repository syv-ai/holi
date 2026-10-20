/**
 * What the Agents mode shows (docs/features/sidebar.md): the agent's own
 * rows, a Holi or a live session, or a row another plugin added (its slot).
 * The selection is core's `agentsSelectionAtom`, shared with those plugins;
 * this module reads the agent's part of it.
 */
import { atom } from 'jotai'
import { agentsSelectionAtom } from '@/plugin-api'

/** The agent's plugin id: the owner of its own rows. */
export const AGENT_OWNER = 'agent'

export type AgentsView =
  | { kind: 'home' }
  /** A Holi's page; `run` scrolls to one of its runs. */
  | { kind: 'holi'; id: string; run?: string }
  /** A live background session, in its terminal. */
  | { kind: 'session'; id: string }
  /** A row another plugin added: its own main view draws it. */
  | { kind: 'slot'; owner: string; id: string }

export const agentsViewAtom = atom(
  (get): AgentsView => {
    const sel = get(agentsSelectionAtom)
    if (sel === null) return { kind: 'home' }
    if (sel.owner !== AGENT_OWNER) return { kind: 'slot', owner: sel.owner, id: sel.id }
    const [kind, ...rest] = sel.id.split(':')
    const id = rest.join(':')
    if (kind === 'session') return { kind: 'session', id }
    if (kind === 'holi') {
      const [holi, run] = id.split('#')
      return { kind: 'holi', id: holi!, ...(run === undefined ? {} : { run }) }
    }
    return { kind: 'home' }
  },
  (_get, set, view: AgentsView) => {
    if (view.kind === 'home') set(agentsSelectionAtom, null)
    else if (view.kind === 'slot') set(agentsSelectionAtom, { owner: view.owner, id: view.id })
    else if (view.kind === 'session')
      set(agentsSelectionAtom, { owner: AGENT_OWNER, id: `session:${view.id}` })
    else
      set(agentsSelectionAtom, {
        owner: AGENT_OWNER,
        id: `holi:${view.id}${view.run === undefined ? '' : `#${view.run}`}`,
      })
  },
)

/** A terminal the Agents view already has for a session (a New session's own
 *  window), so its view shows that one rather than opening another. */
export const viewTerminalsAtom = atom<Record<string, string>>({})
