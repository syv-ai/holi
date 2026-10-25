/**
 * The Holis' rows in the ⌘K command menu (`RendererPlugin.commandMenu`,
 * docs/features/command-palette.md): making one, how they work, and each Holi
 * by name once something is typed, which opens its page as its row does.
 */
import { atom } from 'jotai'
import { Bot, CircleHelp, Plus } from 'lucide-react'
import type { CommandMenuEntry } from '@/plugin-api'
import { holisAtom, holiStateAtom, holiWizardAtom, openHoliAtom } from './state'

const ONE = 'holi:'

const STATE_WORDS: Record<string, string> = { 'needs-you': 'Needs you', working: 'Working' }

export const holiMenuEntriesAtom = atom((get): readonly CommandMenuEntry[] => {
  const states = get(holiStateAtom)
  return [
    {
      id: 'new',
      label: 'New Holi',
      group: 'action',
      icon: Plus,
      keywords: ['holi', 'agent', 'persona', 'create'],
    },
    {
      id: 'learn',
      label: 'How Holis work',
      group: 'action',
      icon: CircleHelp,
      keywords: ['holi', 'help'],
    },
    ...get(holisAtom).map((holi): CommandMenuEntry => {
      const state = STATE_WORDS[states[holi.id] ?? '']
      return {
        id: `${ONE}${holi.id}`,
        label: holi.name,
        group: 'Holis',
        icon: Bot,
        keywords: ['holi', 'agent'],
        ...(state === undefined ? {} : { detail: state }),
      }
    }),
  ]
})

export const runHoliMenuEntryAtom = atom(null, (_get, set, id: string): void => {
  if (id === 'new') set(holiWizardAtom, { mode: 'create' })
  else if (id === 'learn') set(holiWizardAtom, { mode: 'learn' })
  else if (id.startsWith(ONE)) set(openHoliAtom, id.slice(ONE.length))
})
