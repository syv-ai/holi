/** What links is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

export const LINKS_INFO: PluginInfo = {
  id: 'links',
  label: 'Links',
  default: true,
  // The using-links skill.
  addsTo: ['agent'],
  description:
    'Web addresses saved as link files (link.*.md), with a preview of the page on hover and in its tab.',
  whenOff:
    'Previews and New Link go, and a link file opens as a plain note. The files stay as they are.',
}
