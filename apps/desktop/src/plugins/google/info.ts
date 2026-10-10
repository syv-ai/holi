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
  // Choices about your own account, so per vault and per machine: pushed to
  // teammates they would be a disclosure, not a preference.
  settings: [
    {
      key: 'calendars',
      label: 'Calendars',
      explanation:
        'Which of your calendars the agenda, apps and the agent read in this vault, by calendar id. One left out follows the default: your own calendars on, others off.',
      type: { kind: 'switches' },
      default: {},
      target: 'local',
    },
    {
      key: 'imageSenders',
      label: 'Images from',
      explanation:
        'Senders whose remote images always load in this vault, by address. Images are blocked otherwise, since loading one tells the sender you opened it.',
      type: { kind: 'list' },
      default: [],
      target: 'local',
    },
  ],
}
