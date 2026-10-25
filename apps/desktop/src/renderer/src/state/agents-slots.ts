/**
 * The Agents mode's shared seams (docs/features/sidebar.md): what is selected
 * in it, and what plugins other than its provider add to it. Core holds both
 * so the provider and the plugins adding to it never import each other.
 */
import { atom } from 'jotai'
import type { AgentsSlot, ConversationStart } from '@/plugin-api/types'
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
 *  slot that can; its selection opens the tab. Given as a `ConversationStart`,
 *  it can carry context (an app) and open beside what is in front. */
export const startConversationAtom = atom(
  null,
  (
    get,
    set,
    start: string | ConversationStart,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const slot = get(agentsSlotsAtom).find((s) => s.start !== undefined)?.start
    return slot === undefined
      ? Promise.resolve({ ok: false, message: 'No agent is running in this vault.' })
      : set(slot, typeof start === 'string' ? { text: start } : start)
  },
)

/** Start a session through the Agents mode's `newSession`. False when the
 *  mode has none, for the caller to open the mode's home instead. */
export const newAgentSessionAtom = atom(null, (get, set, beside?: boolean): boolean => {
  const start = get(runningPluginsAtom).find((p) => p.agentsMode !== undefined)?.agentsMode
    ?.newSession
  if (start === undefined) return false
  void set(start, beside)
  return true
})
