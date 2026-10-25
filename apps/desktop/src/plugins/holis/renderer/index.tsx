/**
 * The Holis plugin's renderer side (docs/features/holis.md): its section of
 * the Agents sidebar and its rows in the Inbox (the agent's slot), a Holi's
 * page, its dialogs, and its rows in a document's Agent menu. It reaches the
 * agent only through core (`agentSessionRowsAtom`, `showAgentSessionAtom`, the
 * run atoms).
 */
import { HOLIS_INFO } from '../info'
import type { RendererPlugin } from '@/plugin-api'
import { holiMenuEntriesAtom, runHoliMenuEntryAtom } from './command-menu'
import { DocumentHoliActions } from './DocumentHoliActions'
import { HoliDialogs } from './HoliDialogs'
import { HoliPage } from './HoliPage'
import { HolisInbox } from './HolisInbox'
import { HolisSection } from './HolisSection'
import {
  holiEvents,
  holiSessionItemsAtom,
  holiSessionsStatusAtom,
  holisArcadeCastAtom,
  holisStatusAtom,
  holisVault,
  loadHolisAtom,
} from './state'

export const holisRenderer: RendererPlugin = {
  info: HOLIS_INFO,
  events: holiEvents,
  agentsSlot: {
    // After Automations, before the sessions.
    order: 20,
    sidebar: HolisSection,
    main: HoliPage,
    inbox: HolisInbox,
    status: holisStatusAtom,
    // Its runs, in the agent's one session list.
    sessions: {
      items: holiSessionItemsAtom,
      status: holiSessionsStatusAtom,
      reload: loadHolisAtom,
    },
  },
  drawers: [HoliDialogs],
  // Send to Holi, in a document's Agent menu.
  documentActions: DocumentHoliActions,
  vault: holisVault,
  // Its Holis play the empty view's arcade.
  arcadeCast: holisArcadeCastAtom,
  commandMenu: { entries: holiMenuEntriesAtom, run: runHoliMenuEntryAtom },
}
