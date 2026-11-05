/**
 * What Mødelokale Booking seeds into a vault (`vault/` beside this module): the
 * `Booking.local.app` bundle, once, kept on this machine; the room-booking
 * skill, shipped; and an `ask` rule so the agent asks before it books.
 *
 * A booking is a reservation in the person's name that their colleagues see,
 * so it sits in the asking tier: it can be undone on the site, but it should
 * not happen unseen. The rule is a merged fragment, so it reaches vaults
 * seeded before it.
 */
import { seedFolder, type SeedContribution, type SettingsFragment } from '../../../main/plugin-api'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

const SETTINGS: SettingsFragment = {
  permissions: { ask: ['Bash(holi booking book:*)', 'Bash(holi booking cancel:*)'] },
}

export const bookingSeed: SeedContribution = {
  id: 'booking',
  once: folder.once,
  shipped: folder.shipped,
  fragments: { '.claude/settings.json': [SETTINGS] },
}
