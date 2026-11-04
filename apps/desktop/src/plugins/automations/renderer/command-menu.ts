/**
 * Automations' rows in the ⌘K command menu (`RendererPlugin.commandMenu`,
 * docs/features/command-palette.md): the list to go to, a new one, and each
 * automation by name once something is typed. Each opens as its tab, as its
 * row in the Agents sidebar does.
 */
import { atom } from 'jotai'
import { Plus, Zap } from 'lucide-react'
import type { CommandMenuEntry } from '@/plugin-api'
import { automationsAtom, selectAutomationAtom } from './state'

const ONE = 'automation:'

export const automationMenuEntriesAtom = atom((get): readonly CommandMenuEntry[] => [
  {
    id: 'list',
    label: 'Automations',
    group: 'go',
    icon: Zap,
    keywords: ['schedule', 'recurring', 'cron'],
  },
  {
    id: 'new',
    label: 'New automation',
    group: 'action',
    icon: Plus,
    keywords: ['schedule', 'recurring'],
  },
  ...get(automationsAtom).map((a): CommandMenuEntry => ({
    id: `${ONE}${a.path}`,
    label: a.name,
    group: 'Automations',
    icon: Zap,
    keywords: ['automation', 'schedule'],
    detail: a.status === 'on' ? (a.when ?? 'Active') : 'Off',
  })),
])

export const runAutomationMenuEntryAtom = atom(null, (_get, set, id: string): void => {
  set(selectAutomationAtom, id.startsWith(ONE) ? id.slice(ONE.length) : id)
})
