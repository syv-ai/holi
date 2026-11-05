/** What Mødelokale Booking is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it books rooms in one office, so a vault that has people
 *  in that office turns it on. */
export const BOOKING_INFO: PluginInfo = {
  id: 'booking',
  label: 'Mødelokale Booking',
  default: false,
  // Its skill and its ask-before-booking rule live in the agent's `.claude/`.
  addsTo: ['agent'],
  description:
    'Books the Garage meeting rooms at booking.birdsatfive.dk, from a floor-plan app and from the agent (holi booking). Signs in with the emailed login link, read from Gmail when Google is connected. Adds a Booking.local.app folder, kept on this machine.',
  whenOff:
    'The Booking.local.app folder stays, but cannot reach the booking site. The sign-in stays on this machine until you sign out.',
}
