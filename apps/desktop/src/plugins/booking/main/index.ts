/**
 * Mødelokale Booking's main side (docs/features/booking.md): the sign-in to the
 * booking site, kept per machine, and the `booking.*` capabilities behind the
 * Booking app, the settings section and the agent's `holi booking`. It seeds
 * `Booking.local.app`, which runs on the vault apps plugin.
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { BOOKING_INFO } from '../info'
import { createBookingApi } from './api'
import { createBookingAuth, type BookingAuth } from './auth'
import { BOOKING_NAMESPACES, bookingCapabilities } from './capabilities'
import type { MailLookup } from './login-mail'
import { bookingSeed } from './seed'
import { BIRDS_AT_FIVE } from './site'

const api = createBookingApi(BIRDS_AT_FIVE)
/**
 * The sign-in is the machine's, not a vault's: made on the first start and
 * kept while the plugin stops and starts again across vault switches, so a
 * login in flight, the one refresh at a time and the session file's write
 * order all outlive a switch.
 */
let machineAuth: Promise<BookingAuth> | null = null

export const bookingMain: MainPlugin = {
  info: BOOKING_INFO,
  seed: bookingSeed,
  async activate(ctx) {
    // The keychain is Electron's, loaded only when the plugin starts.
    machineAuth ??= import('./electron').then(({ createKeychainSessionStore }) =>
      createBookingAuth({ api, store: createKeychainSessionStore(ctx.userData) }),
    )
    const auth = await machineAuth

    /** Gmail, read through the Google plugin's own capabilities in this vault. */
    const mailFor = (remote: string): MailLookup => {
      if (remote !== ctx.remote) throw new Error('Gmail is read in the open vault only')
      return {
        async search(query) {
          const page = (await ctx.call('google.search', { query })) as {
            threads: { id: string; date: string }[]
          }
          return page.threads
        },
        async messages(id) {
          const thread = (await ctx.call('google.thread', { id })) as {
            messages: { date: string; body: string; html: string | null }[]
          }
          return thread.messages
        },
      }
    }

    return ctx.register(
      BOOKING_NAMESPACES,
      bookingCapabilities({ site: BIRDS_AT_FIVE, api, auth, mailFor }),
    )
  },
}
