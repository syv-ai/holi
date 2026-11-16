/** What Google is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default: nothing shows until a person connects an account on their
 *  own machine, so a vault that never does costs nothing. */
export const GOOGLE_INFO: PluginInfo = {
  id: 'google',
  label: 'Google',
  default: true,
  addsTo: ['agent'],
  description:
    'Mail and Calendar, for you and for the agent, once you connect a Google account on this machine.',
  whenOff: 'Mail and Calendar close. A connected account stays connected on this machine, unused.',
  // Choices about your own account are per vault and per machine: pushed to
  // teammates they would be a disclosure, not a preference.
  settings: [
    {
      key: 'calendars',
      label: 'Calendars',
      explanation:
        'Which of your calendars Calendar, apps and the agent read in this vault, by calendar id. One left out follows the default: your own calendars on, others off.',
      type: { kind: 'switches' },
      default: {},
      target: 'local',
    },
    {
      key: 'imagesFromAllSenders',
      label: 'Images from all senders',
      explanation:
        'Load remote images automatically from every sender in this vault on this machine. This can tell senders when you open mail. Turn off to block images again, except for trusted senders.',
      type: { kind: 'boolean' },
      default: false,
      target: 'local',
      localOnly: true,
    },
    {
      key: 'imageSenders',
      label: 'Images from',
      explanation:
        'Senders whose remote images always load in this vault, by address. Images are blocked otherwise, since loading one tells the sender you opened it.',
      type: { kind: 'list' },
      default: [],
      target: 'local',
      localOnly: true,
    },
    // How the Calendar reads is the vault's, so a team answers it once;
    // `plugins.local.yaml` still overrides it on one machine.
    {
      key: 'timeFormat',
      label: 'Clock',
      explanation: 'How the Calendar writes times: 14:30, or 2:30 PM.',
      type: {
        kind: 'enum',
        options: [
          { value: '24h', label: '24-hour' },
          { value: '12h', label: '12-hour' },
        ],
      },
      default: '24h',
      target: 'committed',
    },
    {
      key: 'weekNumbers',
      label: 'Week numbers',
      explanation: 'ISO week numbers, Monday first, down the side of the Calendar’s month.',
      type: { kind: 'boolean' },
      default: true,
      target: 'committed',
    },
  ],
}
