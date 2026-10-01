/** What the agent is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default: the vault's assistant is most of what a vault is for. */
export const AGENT_INFO: PluginInfo = { id: 'agent', label: 'Agent', default: true }
