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

/** The running plugins' additions, each with its plugin's id, by `order`
 *  (then list order). */
export const agentsSlotsAtom = atom((get): readonly (AgentsSlot & { plugin: string })[] =>
  get(runningPluginsAtom)
    .flatMap((p) => (p.agentsSlot === undefined ? [] : [{ ...p.agentsSlot, plugin: p.info.id }]))
    .map((slot, i) => ({ slot, i }))
    .sort((a, b) => (a.slot.order ?? 200) - (b.slot.order ?? 200) || a.i - b.i)
    .map(({ slot }) => slot),
)

/** Whether a running slot can start a conversation (`AgentsSlot.start`). */
export const canStartConversationAtom = atom((get) =>
  get(agentsSlotsAtom).some((slot) => slot.start !== undefined),
)

/** Start a conversation with `text` as its first message, through the first
 *  slot that can; its selection opens the tab. */
export const startConversationAtom = atom(
  null,
  (get, set, text: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const start = get(agentsSlotsAtom).find((slot) => slot.start !== undefined)?.start
    return start === undefined
      ? Promise.resolve({ ok: false, message: 'No agent is running in this vault.' })
      : set(start, { text })
  },
)
