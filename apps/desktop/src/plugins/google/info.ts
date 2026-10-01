/** What Google is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default: nothing shows until a person connects an account on their
 *  own machine, so a vault that never does costs nothing. */
export const GOOGLE_INFO: PluginInfo = {
  id: 'google',
  label: 'Google',
  default: true,
  description:
    'Mail and Agenda, for you and for the agent, once you connect a Google account on this machine.',
  whenOff: 'Mail and Agenda close. A connected account stays connected on this machine, unused.',
}
