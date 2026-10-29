/** What the agent is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/**
 * Built in: the vault's assistant is most of what a vault is for, and the
 * Agents mode, its sessions and the conversation UI stand on it, so no vault
 * can turn it off. Written to the plugin contract all the same, so core never
 * knows Claude Code, and Holis, automations and the rest build on it as on
 * any plugin (docs/architecture.md, Plugins).
 */
export const AGENT_INFO: PluginInfo = {
  id: 'agent',
  label: 'Agent',
  default: true,
  builtIn: true,
  description:
    'Claude Code in this vault, in tabs beside your notes, with the skills and hooks it was given.',
}
