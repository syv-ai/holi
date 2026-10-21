/**
 * What the mode toggle reports from either mode (docs/features/sidebar.md):
 * everything waiting on the person, and everything working. Live sessions,
 * and what other plugins add through their slots (a Holi's report that asked
 * for the person).
 */
import { atom } from 'jotai'
import { agentsSlotsAtom, type AgentsStatus } from '@/plugin-api'
import { agentSessionsAtom } from './sessions'

export const agentsStatusAtom = atom((get): AgentsStatus => {
  let needsYou = 0
  let working = 0
  for (const s of get(agentSessionsAtom)) {
    if (s.state === 'needs-you') needsYou++
    else if (s.state === 'working') working++
  }
  for (const slot of get(agentsSlotsAtom)) {
    if (slot.status === undefined) continue
    const s = get(slot.status)
    needsYou += s.needsYou
    working += s.working
  }
  return { needsYou, working }
})

/** What the Inbox holds: the sessions waiting on the person, and what the
 *  slots count as needing them. */
export const inboxCountAtom = atom((get): number => {
  let n = get(agentSessionsAtom).filter((s) => s.state === 'needs-you').length
  for (const slot of get(agentsSlotsAtom)) {
    if (slot.inbox !== undefined && slot.status !== undefined) n += get(slot.status).needsYou
  }
  return n
})
