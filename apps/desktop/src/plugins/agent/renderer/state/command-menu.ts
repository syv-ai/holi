/**
 * The agent's rows in the ⌘K command menu (`RendererPlugin.commandMenu`,
 * docs/features/command-palette.md): the Inbox and History to go to, and every
 * conversation in the session list, found by its title once something is
 * typed. Opening one is what picking its row in the sidebar does.
 */
import { atom } from 'jotai'
import { History, Inbox, MessageSquare } from 'lucide-react'
import type { CommandMenuEntry } from '@/plugin-api'
import { inboxCountAtom } from './agents-status'
import { agentsViewAtom } from './agents-view'
import { openSessionRowAtom, sessionRowsAtom } from './session-list'

const ROW = 'row:'

const STATE_WORDS = { 'needs-you': 'Needs you', working: 'Working', done: 'Done', idle: '' }

export const agentMenuEntriesAtom = atom((get): readonly CommandMenuEntry[] => {
  const inbox = get(inboxCountAtom)
  return [
    {
      id: 'inbox',
      label: 'Inbox',
      group: 'go',
      icon: Inbox,
      keywords: ['needs you', 'approvals', 'agents'],
      ...(inbox > 0 ? { detail: `${inbox} need you` } : {}),
    },
    {
      id: 'history',
      label: 'History',
      group: 'go',
      icon: History,
      keywords: ['sessions', 'conversations', 'past', 'closed'],
    },
    ...get(sessionRowsAtom)
      .filter((row) => row.item.archived !== true)
      .map((row): CommandMenuEntry => {
        const words = [STATE_WORDS[row.state], row.item.by?.name].filter(Boolean)
        return {
          id: `${ROW}${row.item.key}`,
          label: row.item.title,
          group: 'Conversations',
          icon: MessageSquare,
          keywords: ['session', 'chat', 'conversation'],
          ...(words.length > 0 ? { detail: words.join(' · ') } : {}),
        }
      }),
  ]
})

export const runAgentMenuEntryAtom = atom(null, (get, set, id: string): void => {
  if (id === 'inbox') {
    set(agentsViewAtom, { kind: 'inbox' })
    return
  }
  if (id === 'history') {
    set(agentsViewAtom, { kind: 'history' })
    return
  }
  if (!id.startsWith(ROW)) return
  const key = id.slice(ROW.length)
  const row = get(sessionRowsAtom).find((r) => r.item.key === key)
  if (row !== undefined) void set(openSessionRowAtom, row.item)
})
