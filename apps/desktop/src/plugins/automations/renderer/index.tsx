/**
 * The automations plugin's renderer side (docs/features/scheduled-agents.md):
 * its row under the Agents Inbox and its view, the list beside the editor
 * (the agent's slot).
 */
import type { RendererPlugin } from '@/plugin-api'
import { AUTOMATIONS_INFO } from '../info'
import { AutomationsNav } from './AutomationsNav'
import { AutomationsView } from './AutomationsView'
import { automationEvents, automationsVault } from './state'

export const automationsRenderer: RendererPlugin = {
  info: AUTOMATIONS_INFO,
  events: automationEvents,
  agentsSlot: {
    order: 10,
    nav: AutomationsNav,
    main: AutomationsView,
  },
  vault: automationsVault,
}
