/**
 * What the mode toggle reports from either mode (docs/features/sidebar.md):
 * everything waiting on the person, and everything working. Live sessions,
 * Holis (a run waiting, or a report that asked for the person), and what
 * other plugins add through their slots.
 */
import { atom } from 'jotai'
import { agentsSlotsAtom, type AgentsStatus } from '@/plugin-api'
import { holiJobIdsAtom, holiStateAtom } from './holis'
import { agentSessionsAtom } from './sessions'

export const agentsStatusAtom = atom((get): AgentsStatus => {
  let needsYou = 0
  let working = 0
  const runs = get(holiJobIdsAtom)
  for (const s of get(agentSessionsAtom)) {
    if (runs.has(s.id)) continue
    if (s.state === 'needs-you') needsYou++
    else if (s.state === 'working') working++
  }
  for (const state of Object.values(get(holiStateAtom))) {
    if (state === 'needs-you') needsYou++
    else if (state === 'working') working++
  }
  for (const slot of get(agentsSlotsAtom)) {
    if (slot.status === undefined) continue
    const s = get(slot.status)
    needsYou += s.needsYou
    working += s.working
  }
  return { needsYou, working }
})
