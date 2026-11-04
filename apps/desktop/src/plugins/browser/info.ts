/** What the browser is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

export const BROWSER_INFO: PluginInfo = {
  id: 'browser',
  label: 'Browser',
  // Off until a vault asks: the agent can act on any site this machine is
  // signed in to here.
  default: false,
  // The using-the-browser skill.
  addsTo: ['agent'],
  description:
    'Web pages in a tab, which the agent can read, click, type into and screenshot with holi browser.',
  whenOff:
    'Its tabs close and holi browser goes. Sites stay signed in on this machine for the next time.',
}
