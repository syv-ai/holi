/**
 * The Agents mode's shared seams (docs/features/sidebar.md): what is selected
 * in it, and what plugins other than its provider add to it. Core holds both
 * so the provider and the plugins adding to it never import each other.
 */
import { atom } from 'jotai'
import type { AgentsSlot } from '@/plugin-api/types'
import { runningPluginsAtom } from './plugins'

/** What the Agents mode shows: a row of `owner`'s (a plugin id), by its own
 *  id. Null shows the provider's default. */
export interface AgentsSelection {
  owner: string
  id: string
}

export const agentsSelectionAtom = atom<AgentsSelection | null>(null)

/** The running plugins' additions, each with its plugin's id, in list order. */
export const agentsSlotsAtom = atom((get): readonly (AgentsSlot & { plugin: string })[] =>
  get(runningPluginsAtom).flatMap((p) =>
    p.agentsSlot === undefined ? [] : [{ ...p.agentsSlot, plugin: p.info.id }],
  ),
)
