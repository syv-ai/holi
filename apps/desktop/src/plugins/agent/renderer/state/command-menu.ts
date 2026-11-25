/**
 * The agent's rows in the ⌘K command menu (`RendererPlugin.commandMenu`,
 * docs/features/command-palette.md): the Inbox, History and Memory to go
 * to, and every conversation in the session list, found by its title once
 * something is typed. Opening one is what picking its row in the sidebar does.
 */
import { atom } from 'jotai'
import { Brain, History, Inbox, MessageSquare } from 'lucide-react'
import { activeVaultSettingsAtom, type CommandMenuEntry } from '@/plugin-api'
import { inboxCountAtom } from './agents-status'
import { agentsViewAtom } from './agents-view'
import { openSessionRowAtom, sessionRowsAtom } from './session-list'

const ROW = 'row:'

const STATE_WORDS = { 'needs-you': 'Needs you', working: 'Working', done: 'Done', idle: '' }

export const agentMenuEntriesAtom = atom((get): readonly CommandMenuEntry[] => {
  const inbox = get(inboxCountAtom)
  const settings = get(activeVaultSettingsAtom)
  const entries: CommandMenuEntry[] = [
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
    {
      id: 'memory',
      label: 'Memory',
      group: 'go',
      icon: Brain,
      keywords: ['remember', 'memories', 'facts', 'agents'],
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
  return entries.filter((entry) =>
    entry.id === 'inbox'
      ? settings?.agentInbox
      : entry.id === 'history'
        ? settings?.agentHistory
        : entry.id === 'memory'
          ? settings?.agentMemory
          : true,
  )
})

export const runAgentMenuEntryAtom = atom(null, (get, set, id: string): void => {
  if (id === 'inbox') {
    if (!get(activeVaultSettingsAtom)?.agentInbox) return
    set(agentsViewAtom, { kind: 'inbox' })
    return
  }
  if (id === 'history') {
    if (!get(activeVaultSettingsAtom)?.agentHistory) return
    set(agentsViewAtom, { kind: 'history' })
    return
  }
  if (id === 'memory') {
    if (!get(activeVaultSettingsAtom)?.agentMemory) return
    set(agentsViewAtom, { kind: 'memory' })
    return
  }
  if (!id.startsWith(ROW)) return
  const key = id.slice(ROW.length)
  const row = get(sessionRowsAtom).find((r) => r.item.key === key)
  if (row !== undefined) void set(openSessionRowAtom, row.item)
})
